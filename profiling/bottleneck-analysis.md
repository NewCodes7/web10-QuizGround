# 병목 분석 보고서 — CPU + Heap 통합

**CPU 프로파일**: `cpu-2026-04-30T13-01-56.cpuprofile` (120.2초, 샘플 3,237개)  
**Heap 프로파일**: `Heap.20260501.015518.750499.0.001.heapprofile` (총 43.3 MB 할당 기록)  
**부하 조건**: 200명 룸 / Socket.IO 브로드캐스트 / POSITION_BATCH_TIME=50ms

---

## 결론 먼저

**가장 큰 단일 병목: Socket.IO 브로드캐스트 경로의 단수명(short-lived) Buffer 대량 생성**

이것이 CPU의 두 개 최상위 항목(GC 17.1% + 직렬화 19.2%)을 동시에 설명하는 하나의 근인(root cause)이다.  
이 두 항목은 별개의 문제가 아니라 **같은 원인의 두 가지 증상**이다.

부하테스트 중 GC 세대 측정 결과는 이 가설을 직접 검증한다:

| 측정값 | 수치 | 의미 |
|---|---|---|
| Minor GC 비율 | **~95%** | 거의 모든 객체가 새 공간(new space)에서 죽음 = 단수명 Buffer 가설 직접 확인 |
| New space 패턴 | 70% → 2~3% → 30%+ 반복 | Scavenge가 매우 효율적이나 극히 자주 발생 |
| Old space 증가 | **+17 MB** | 일부 객체가 승격(promotion)되어 누적 → Major GC 유발 |
| Large object space | **~2 MB, 변화 없음** | 문제는 대형 객체 1개가 아니라 소형 객체 수십만 개 |
| 증상 | **초반에는 빠르다가 점점 느려짐** | Minor GC → Major GC 전환의 교과서적 패턴 |

---

## 1. CPU 프로파일 전체 분포

| 카테고리 | CPU 시간 | 비율 |
|---|---|---|
| Socket.IO 직렬화 (`encodeAsString`, `hasBinary`, `writeUtf8String`) | 23,113ms | **19.2%** |
| **GC (가비지 컬렉션)** | 20,576ms | **17.1%** |
| Idle | 10,317ms | 8.6% |
| Network I/O (`writev`) | 6,296ms | 5.2% |
| RxJS | 4,882ms | 4.1% |
| NestJS ValidationPipe | 2,463ms | 2.0% |
| 게임 서비스 코드 | 2,800ms | 2.3% |
| `util.deprecate` 런타임 호출 | ~2,041ms | 1.7% |
| Socket.IO adapter | 1,300ms | 1.1% |
| 기타 | — | 38.7% |

**Active CPU(Idle 제외) 기준 GC 비율: 18.7%** — 정상 범위(< 5%)의 3.7배

---

## 2. Heap 프로파일 전체 분포

### 2-1. 전체 할당 (43.3 MB)

| 단계 | selfSize | 비율 |
|---|---|---|
| **스타트업** (모듈 로더 체인) | 30.5 MB | **70.4%** |
| **런타임** (실제 이벤트 루프 작업) | 12.8 MB | 29.6% |

힙 프로파일의 70%는 프로세스 기동 시 단 1회 발생하는 비용이다.  
런타임 병목을 보려면 런타임 분만 따로 보아야 한다.

### 2-2. 런타임 할당 카테고리 (12.8 MB)

| 카테고리 | selfSize | 런타임 내 비율 |
|---|---|---|
| node builtins (timers, fs, buffer 등) | 5.25 MB | 40.95% |
| 기타 node_modules | 1.54 MB | 11.99% |
| NestJS 프레임워크 | 1.25 MB | 9.72% |
| LRU/Denque (캐시 큐) | 1.17 MB | 9.14% |
| Socket.IO | 455 KB | 3.55% |
| MySQL2 | 263 KB | 2.05% |
| RxJS | 258 KB | 2.01% |
| ioredis | 189 KB | 1.48% |
| class-validator/transformer | 172 KB | 1.34% |
| **게임 코드 전체** | **~459 KB** | **~3.6%** |

### 2-3. 게임 코드 런타임 할당 세부 (459 KB 안에서)

| 파일 / 함수 | selfSize | 특이사항 |
|---|---|---|
| `position-broadcast` / `handleRetransmit` | 23,544 B | Redis pub/sub 위치 재전송 |
| `game-room` / `joinRoom` | 23,056 B | 플레이어 입장당 객체 다수 생성 |
| `game-room` / `handlePlayerExit` | 12,936 B | 연결 해제 cleanup |
| `game-session` / `setPlayerName` | 12,864 B | 세션 객체 구성 |
| `metric.service` / `isCurrentlyCollecting` | 12,112 B | 이벤트마다 상태 객체 생성 |
| `metric.interceptor` / `intercept` | 11,704 B | 소켓 이벤트마다 RxJS 체인 생성 |
| `game-chat` / `broadcastRoom` | 11,608 B | 브로드캐스트마다 메시지 객체 |
| `position-broadcast` / `handlePositionMessage` | 10,312 B | Redis subscriber → 위치 이벤트 |
| `game-chat` / `persistRoom` | 10,264 B | 타이머 flush |

---

## 3. 핵심 병목 상세 분석

### 3-1. [최우선] Socket.IO 브로드캐스트 = GC + 직렬화의 공통 근인

#### 메커니즘

Socket.IO v4.8.1의 브로드캐스트 내부 흐름:

```
server.to(socketIds).emit(EVENT, payload)
  └─ adapter._encode()          ← 브로드캐스트당 1회
       ├─ hasBinary(payload)    ← payload 전체 재귀 순회 (중간 배열 생성)
       ├─ encodeAsString()      ← JSON.stringify → string 1개 생성
       ├─ Buffer.from("4"+str)  ← UTF-8 string → Buffer 변환 (즉시 버려짐)
       └─ WebSocket.Sender.frame() ← WS 프레임 구조체 1개 생성
  └─ socket N개 루프
       └─ sender.sendFrame(wsPreEncodedFrame)   ← 재사용, 변환 없음
```

v4.8.1에서는 WS 프레임을 브로드캐스트당 1번만 만들고 N개 소켓에 재사용한다.  
**성능 문제는 소켓당 N번 변환이 아니라, 브로드캐스트 자체의 높은 호출 빈도다.**

#### 수치 계산

```
브로드캐스트 빈도 = 위치(2회/100ms) × 200명 = 초당 약 2,000회
브로드캐스트당 생성 객체:
  - JSON string  (즉시 버려짐)
  - Buffer       (즉시 버려짐)
  - WS frame     (즉시 버려짐)
  - hasBinary 중간 배열 (즉시 버려짐)

→ 120초 기준: 240,000+ Buffer 객체 생성 → 즉시 GC 대상
```

#### CPU 프로파일에서의 증거

```
encodeAsString   6.5% + 2.8% + 1.5% + 0.5% = 11.3%   (4개 샘플 그룹에 분산 → 높은 호출 빈도 신호)
hasBinary                                   = 3.4%    [is-binary.js]
writeUtf8String                             = 1.8%    (per-socket 1:1 경로)
(garbage collector)                         = 17.1%   (생성된 Buffer들의 수거 비용)
```

`encodeAsString`이 4개 샘플 그룹에 분산된 이유:  
"소켓마다 4번 호출"이 아니라, 120초 동안 수만 번 호출되어 샘플링 창 여러 개에 걸쳐 나타난 것이다.

#### GC stop-the-world 영향

Node.js V8의 GC는 **stop-the-world** 방식이다.  
GC가 동작하는 동안 이벤트 루프 전체가 멈춘다 → 소켓 응답이 그 시간만큼 지연된다.

- CPU 기준 GC 비율 17.1% → active CPU의 18.7%
- 정상 서버에서 GC는 < 5%가 기준. 현재는 3.7배 초과.

---

### 3-1-bis. GC 세대별 동작 분석 — 부하테스트 측정으로 확인된 인과 사슬

#### V8 세대별 GC 구조 (기본 이해)

```
┌───────────────────────────────────────────────────────┐
│ New Space (Young Generation)  ← 새 객체 전부 여기서 시작   │
│  ┌────────────┐  ┌────────────┐                        │
│  │ from-space │  │  to-space  │  각 ~16MB              │
│  └────────────┘  └────────────┘                        │
│   Scavenge(Minor GC): from→to로 살아남은 것만 복사       │
│   2회 생존 시 → Old Space로 승격(promote)               │
├───────────────────────────────────────────────────────┤
│ Old Space (Old Generation)  ← 오래 살아남은 객체          │
│   Mark-Sweep-Compact (Major GC): 훨씬 느리고 긴 pause  │
├───────────────────────────────────────────────────────┤
│ Large Object Space  ← 단일 객체 > 256 KB               │
└───────────────────────────────────────────────────────┘
```

#### 측정값 해석

**Minor GC 95%**: 생성된 객체의 절대 다수가 new space에서 죽는다.  
Socket.IO 브로드캐스트마다 생성된 Buffer/string/frame이 모두 new space에서 즉시 버려지고 있다는 **직접 증거**다.

**New space: 70% → 2~3% → 30%+ 반복**

```
단계 1: 새 객체 대량 생성
  new space: 2-3% ──────────────────► 70%
  (브로드캐스트 Buffer들이 빠르게 채움, 초당 ~2,000개)

단계 2: Scavenge 발동 (threshold: ~70-80%)
  from-space 전체를 to-space로 스캔
  살아있는 것만 복사 → 죽은 것(97~98%) 버림
  new space: 70% ─────► 2~3%
  ※ pause: ~1~5ms (빠르지만 자주 발생)

단계 3: 리바운드 (Scavenge 직후 30%로 오름)
  이 30%는 직전 Scavenge에서 살아남아 to-space에 이미 존재하던 객체들
  + 단계 2가 완료되자마자 다시 시작된 새 브로드캐스트 Buffer들
  → 이 30% 생존자들이 "2회 생존" 임계를 넘으면 다음 Scavenge에서 Old Space로 승격
```

**Old space +17 MB**: Scavenge를 2회 이상 살아남은 객체들이 승격된 결과.  
무엇이 승격되는가?

| 승격 가능 객체 | 이유 |
|---|---|
| ioredis 대기 명령 객체 | Redis 응답이 오기 전까지 살아있음. 부하 상황에서 응답 지연 → Scavenge 1회 이상 통과 |
| `metric.interceptor` RxJS 체인 | 소켓 이벤트 처리 전 기간 동안 살아있음 (완료까지 여러 tick) |
| WS `Sender.frame()` 구조체 | 200개 소켓 전송 완료까지 참조가 유지될 수 있음 |
| `processTimers` 콜백 클로저 | 타이머가 fire될 때까지 참조 유지 |

**Large object space ~2 MB, 변화 없음**: 문제는 큰 객체 하나가 아니라 **수십만 개의 작은 객체**임을 확인.  
각각은 수백 바이트짜리 Buffer지만, 초당 2,000개 × 120초 = 24만 개 생성.

#### "점점 느려지는" 현상의 완전한 인과 사슬

```
T=0 ~ 초반
  new space 빠르게 차고 → Scavenge 자주 발동 (~5~10초마다)
  Scavenge pause: 1~5ms → 체감 불가
  캐릭터 움직임: 정상

T=중반 (Old space 점점 누적)
  Scavenge마다 일부 객체가 Old space로 승격
  Old space: 점진적으로 17MB 증가
  Scavenge 빈도는 여전히 높음 (new space는 계속 차기 때문)
  누적된 Scavenge pause들이 응답 지연으로 감지되기 시작

T=후반 (Old space threshold 도달)
  V8이 Mark-Sweep-Compact (Major GC) 발동
  Major GC pause: 수십~수백ms (Scavenge의 수십 배)
  이벤트 루프 수백ms 정지 → 소켓 이벤트 전혀 처리 못 함
  캐릭터 위치 업데이트 중단 → "얼었다가 순간이동"처럼 보임
  
  게임이 진행될수록 Major GC 빈도 증가 → 점점 더 눈에 띄는 랙
```

이것이 "초반에는 빠르다가 점점 느려지는" 현상의 정확한 메커니즘이다.  
GC 로그(`--expose-gc` + `--trace-gc`)로 확인하면 후반부에 `Mark-Sweep` 로그가 증가함을 볼 수 있다.

---

### 3-2. [2순위] 스타트업 시 불필요한 모듈 로딩

Heap 프로파일 기준 스타트업 30.5 MB 중 불필요한 비용:

#### A. `cli-highlight` (TypeORM SQL 로거 경유)

```
app.module.js → typeorm → PlatformTools.js → cli-highlight → highlight.js (190개 언어 문법 전부 로드)
```

- `registerLanguage` selfSize: **761 KB**
- 프로덕션에서 TypeORM `logging: false`이면 로드되지 않아야 한다.
- `app.module.ts`에서 `synchronize: true`, `logging: true`가 DEV 외에도 켜져 있다면 수정 필요.

#### B. `libphonenumber-js/max` (class-validator `@IsPhoneNumber` 경유)

```
game.gateway.js → chat-message.dto.js → class-validator/decorator/decorators.js → IsPhoneNumber → libphonenumber-js/max/index.cjs
```

- `Module._extensions..json` selfSize: **512 KB** (전화번호 데이터셋)
- 게임 DTO에서 `@IsPhoneNumber`를 실제로 사용하는 경우는 없을 가능성이 높다.
- class-validator를 배럴(barrel) 전체 임포트(`from 'class-validator'`)하면 모든 데코레이터 메타데이터가 로드된다.

#### C. TypeORM 미사용 DB 드라이버

TypeORM이 CockroachDB, PostgreSQL, SQL Server 드라이버를 MySQL과 함께 로드한다.  
각각 `readFileSync` 체인을 수십 KB씩 유발.

---

### 3-3. [3순위] ioredis Denque 큐 리사이징 (`metric.interceptor` 연결)

**Heap 증거**:
```
metric.interceptor.js → recordLatency → ioredis/Commander.sendCommand → denque/_copyArray
selfSize: 131 KB (런타임, 1.02%)
```

- ioredis 내부 명령 큐(Denque)가 초기 용량을 초과해 `_growArray`(배열 복사)가 발생.
- 트리거 경로가 `metric.interceptor`라는 점이 중요: 소켓 이벤트마다 메트릭 인터셉터가 Redis 명령을 발행하고 있다.
- 메트릭 측정용 Redis 호출이 게임 플레이 Redis 호출과 같은 큐에서 경합.
- 명령 큐가 커지면 → 명령 응답 지연 → 게임 서비스 Redis 응답도 느려짐.

---

### 3-4. [4순위] NestJS ValidationPipe — hot path에서의 반복 비용

**CPU 증거**:
```
getTargetValidationMetadatas  [MetadataStorage.js]   0.6%
transform                     [TransformOperationExecutor.js]  0.6% + 0.2%
getKeys                       [TransformOperationExecutor.js]  0.6%
execute                       [ValidationExecutor.js]          0.4%
합계: 2.0%
```

`updatePosition` 이벤트는 초당 수십~수백 회 발생한다.  
매 이벤트마다 class-validator가 메타데이터 맵을 탐색하고 class-transformer가 객체를 변환한다.

---

### 3-5. [5순위] `util.deprecate` 런타임 호출

**CPU 증거**:
```
deprecate  [util:146]   0.7% + 0.5% + 0.3% = ~1.7%
```

`util.deprecate()`로 감싼 함수가 **요청 처리 경로 안에서 매번** 호출된다.  
경고 출력은 1회지만 함수 호출 오버헤드는 매번 발생한다.  
ioredis 또는 Socket.IO의 버전 간 호환성 문제로 deprecated API를 사용하고 있다는 신호.

---

## 4. 병목 간 관계 정리

```
[근인] 초당 ~2,000회 브로드캐스트
  × 브로드캐스트당: JSON string + Buffer.from("4"+str) + WS frame + hasBinary 중간 배열
         │
         ├─► CPU 19.2% : encodeAsString + hasBinary 직렬화 비용 (동기 실행 비용)
         │
         └─► new space 초당 2,000개 Buffer 생성
                  │
                  ├─► Scavenge (Minor GC) 빈번 발동 — 95% of GC
                  │      new space: 70% → 2% → 30% → 70% ... 반복
                  │      pause: 1~5ms, 짧지만 자주
                  │      ↓
                  │   일부 객체 Old Space 승격 (+17 MB 누적)
                  │      │
                  │      └─► Major GC (Mark-Sweep-Compact) 발동
                  │               pause: 수십~수백 ms
                  │               이벤트 루프 완전 정지
                  │               ↓
                  └─► CPU 17.1% GC 총합 (Scavenge + Major GC)
                               ↓
                        [시간 경과에 따른 진행성 악화]
                        초반: Scavenge만 → 체감 불가
                        중반: Scavenge 누적 + 간헐 Major GC → 경미한 랙
                        후반: Major GC 빈도 증가 → 캐릭터 얼었다가 순간이동
                               Large object space 변화 없음 → 큰 단일 객체 아님
```

**따라서 msgpack 파서 교체 하나로 직렬화 + Minor GC 빈도 + Old space 승격 압박을 동시에 해결할 수 있다.**  
Buffer 생성 횟수 자체를 줄이면 Scavenge 발동 빈도가 줄고 → Old space 승격도 줄고 → Major GC가 늦게, 덜 발생한다.

---

## 5. 개선 방향 및 예상 효과

### 5-1. [즉시] msgpack 파서 교체 (예상 효과: CPU 15~20% 절감 + GC 절반 이하)

`@socket.io/msgpack-parser`를 BE/FE 동시 적용:

| 함수 | 현재 | msgpack 교체 후 |
|---|---|---|
| `hasBinary` | payload 전체 재귀 순회 (매 브로드캐스트) | **제거됨** (항상 binary) |
| `encodeAsString` | JSON.stringify → string 생성 | binary encode (더 빠름) |
| `writeUtf8String` | string → Buffer 변환 | UTF-8 변환 자체가 없음 |
| 생성 Buffer 수 | 브로드캐스트당 1개 + 중간 객체들 | binary Buffer 1개만 생성 |

```typescript
// BE: main.ts 또는 gateway
import { encode, decode } from '@socket.io/msgpack-parser';
const io = new Server(httpServer, { parser: { encode, decode } });

// FE: socket.ts
import { encode, decode } from '@socket.io/msgpack-parser';
const socket = io(url, { parser: { encode, decode } });
```

> **주의**: FE/BE 동시 배포 필요. 파서가 달리 설정된 클라이언트는 메시지 파싱 실패.

---

### 5-2. [즉시] hot path에서 ValidationPipe 제거 (예상 효과: CPU 2% 절감 + 지연 감소)

`updatePosition` 핸들러에서 `@UsePipes(ValidationPipe)` 제거하거나,  
수동으로 최소 타입 체크만 수행.

```typescript
// 현재: ValidationPipe가 매 이벤트마다 class-validator 전체 실행
@SubscribeMessage(SOCKET_EVENTS.UPDATE_POSITION)
@UsePipes(new ValidationPipe())
handleUpdatePosition(@MessageBody() dto: UpdatePositionDto) { ... }

// 개선: hot path에서 파이프 제거, 수동 검증
@SubscribeMessage(SOCKET_EVENTS.UPDATE_POSITION)
handleUpdatePosition(@MessageBody() data: unknown) {
  if (typeof data?.x !== 'number' || typeof data?.y !== 'number') return;
  // ...
}
```

---

### 5-3. [단기] 스타트업 최적화

**TypeORM SQL 로깅 확인**: `app.module.ts`에서 `logging` 옵션이 프로덕션에서 `false`인지 확인.
```typescript
// app.module.ts
TypeOrmModule.forRoot({
  logging: process.env.NODE_ENV === 'development',   // 반드시 조건부여야 함
  // ...
})
```

**libphonenumber-js 제거**: `chat-message.dto.ts` 등 게임 DTO에서 `@IsPhoneNumber` 사용 여부 확인.  
사용하지 않는다면 해당 import를 제거하거나 class-validator를 부분 임포트.

---

### 5-4. [단기] 메트릭 인터셉터 분리

현재 `metric.interceptor`가 모든 소켓 이벤트마다 Redis 명령을 발행해 ioredis 큐 경합을 일으킨다.  
메트릭 수집용 Redis 클라이언트를 게임 Redis 클라이언트와 분리하거나,  
메트릭 수집을 Redis 대신 인메모리 카운터로 전환(Prometheus prom-client 직접 사용).

---

### 5-5. [중기] deprecated API 경로 제거

Node.js deprecation 경고가 요청 처리 경로에서 발생 중.  
스택 트레이스 확인:

```bash
NODE_OPTIONS="--trace-deprecation" node dist/src/main.js 2>&1 | grep -A 10 "DeprecationWarning"
```

ioredis나 Socket.IO의 구버전 API 사용이 원인일 가능성이 높으며,  
대체 API로 교체 또는 최신 버전으로 업그레이드.

---

## 6. 우선순위 요약

| 순위 | 개선 항목 | 예상 CPU 절감 | 예상 GC 절감 | 난이도 |
|---|---|---|---|---|
| 1 | **msgpack 파서 교체** | ~15–20% | ~50% 이상 | 하 (FE/BE 동시 배포) |
| 2 | hot path ValidationPipe 제거 | ~2% | 미미 | 하 |
| 3 | TypeORM logging 조건부 확인 | — | 스타트업 개선 | 하 |
| 4 | 메트릭 인터셉터 ioredis 분리 | ~1% | 미미 | 중 |
| 5 | deprecated API 경로 제거 | ~1–2% | 미미 | 중 |

---

## 7. 프로파일 읽는 법 — 방법론 정리

### CPU 프로파일 (`cpuprofile`)

구조: `{ nodes, samples, timeDeltas }`

- `nodes`: 함수 콜 스택 노드 (callFrame = 파일/함수/라인)
- `samples`: 각 시점에 CPU가 어디 있었는지 (노드 ID)
- `timeDeltas`: 샘플 사이 경과 시간

핵심 계산: **노드별 총 시간 = 해당 노드 샘플 횟수 × 샘플 간격**  
본 프로파일은 샘플 간격 37ms (V8 샘플링 주기를 의도적으로 늘린 결과) — 짧은 함수는 과소평가될 수 있다.

주의: **카운트 기반 비율과 timedelta 기반 비율을 혼동하지 말 것.**  
GC는 stop-the-world라 실제 영향력은 timedelta 기반으로 측정해야 한다.

### Heap 샘플링 프로파일 (`heapprofile`)

V8 샘플링 힙 프로파일러: **어느 함수에서 메모리를 얼마나 할당하는지** 기록.  
`heapsnapshot`(특정 시점 스냅샷)과 달리 시간 흐름에 따른 **누적 할당량**을 보여준다.

본 프로파일의 함정: **기동 직후 캡처라 스타트업 비용(70.4%)이 런타임 비용을 압도한다.**  
정확한 런타임 메모리 분석을 위해서는 부하 테스트 진행 중 프로파일을 캡처해야 한다.

Chrome DevTools 분석 순서:
1. `chrome://inspect` → Memory 탭 → Load → `.heapprofile`
2. **Heavy (Bottom Up)** 뷰, **Self Size** 기준 정렬
3. 스타트업 경로(`Module._load`, `executeUserEntryPoint`) 하위는 제외하고 런타임 경로만 분석
