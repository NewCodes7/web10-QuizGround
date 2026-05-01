# CPU Profiling 분석 보고서

- grafana: http://34.158.197.135/grafana/d/quizground-loadtest/1f1b49f5-8511-57ff-8d31-40c4d2b819e9?orgId=1&from=1777553881943&to=1777554350371
**파일**: `cpu-2026-04-30T13-01-56.cpuprofile`  
**프로파일 시간**: 120.2초 (부하 테스트 중 측정)  
**샘플 수**: 3,237개 / 평균 샘플 간격: 37ms  
> 샘플 간격이 37ms로 넓음 — 이전 커밋에서 "V8 샘플링 주기 증가"로 의도적으로 늘린 결과. 짧은 함수는 과소평가될 수 있음.

---

## 전체 CPU 시간 분포

| 카테고리 | 비율 | 시간 |
|---------|------|------|
| **GC (가비지 컬렉션)** | **17.1%** | 20,576ms |
| Socket.IO 직렬화 | 19.2% | 23,113ms |
| Network I/O (`writev`) | 5.2% | 6,296ms |
| RxJS | 4.1% | 4,882ms |
| Idle | 8.6% | 10,317ms |
| 게임 서비스 코드 | 2.3% | 2,800ms |
| NestJS ValidationPipe | 2.0% | 2,463ms |
| `util.deprecate` 경고 | 1.7% | ~2,041ms |
| Socket.IO adapter | 1.1% | 1,300ms |
| 기타 (미분류) | 34.3% | — |

**Active CPU 기준 GC 비율: 18.7%** (idle 제외 시) — 정상 범위(< 5%)를 크게 초과.

---

## 핵심 병목 #1 — GC 압박 (17.1%)

### 증거
```
(garbage collector)  17.1%  20,576ms
```

### 의미
- GC가 전체 CPU 시간의 1/6을 차지. Node.js의 GC는 **stop-the-world** 방식이라, 
- GC가 돌 때 이벤트 루프가 멈춤 → 소켓 응답 지연으로 직결.
- 아 그래서 초반에 부하가 있는 게 아니라 테스트 진행할수록 뒤에서 부하가 생겼구나 

### 원인 추정
- `writeUtf8String`은 broadcast 경로에서는 **브로드캐스트당 1번**만 실행됨 (`_encode()`에서 미리 계산한 `wsPreEncodedFrame`을 N개 소켓에 그대로 전달)
- 단, per-socket 1:1 경로(`POSITION_RETRANSMIT_RESPONSE`, 입장 시 `JOIN_ROOM` 등)는 `wsPreEncodedFrame` 없이 매번 `encodePacket()` → `writeUtf8String` 실행
- 주된 Buffer 양산 원인은 `writeUtf8String` 자체보다 **높은 브로드캐스트 빈도** (200명 방 × 초당 10회 = 초당 2,000번 `Buffer.from("4"+str)` + `Sender.frame()` 생성 후 즉시 버려짐, `POSITION_BATCH_TIME=50ms` IN/OUT 엇갈림 → 실질 emit 주기 100ms)
- 생성된 Buffer가 전부 단수명(short-lived) 객체라 GC 대상이 됨
- `hasBinary()`가 브로드캐스트마다 페이로드 전체를 재귀 순회 → 중간 배열/객체 추가 생성

### 개선 방향
- **msgpack 파서 교체**: `writeUtf8String`의 string→Buffer 변환 비용을 binary Buffer 복사로 대체, `hasBinary` 제거 → 아래 병목 #2 참고

### 궁금증 정리
- 보면 8.4%라 나와있는데 어떻게 17.1%라 계산했을까? 
- 8.4%는 샘플 찍은 횟수로 계산된 것 
- 하지만, GC는 stop-the-world라 실제 샘플링 간격보다 더 길어질 수 있음
- 그렇기에 실제 영향력을 파악하기 위해서는 개수로 카운팅하는 게 아니라, 얼마만큼 실행되었는지 그 시간을 봐야 함 
- GC에 쓴 시간 합 / 전체 시간 = 실제 GC 비율
- 쉽게 정리하자면
  - 카운트 기반
  - timedelta 기반

### 추가 정리 
- 현재는 GC의 부담을 줄이는 게 1순위임 
- 생성된 버퍼를 잘 관리하는 방법? 
- gc 대상이 되는 주 객체를 보는 방법? -> 대시보드 만들어야 하나? 

---

## 핵심 병목 #2 — Socket.IO 직렬화 (19.2%)

### 증거
```
encodeAsString  6.5% + 2.8% + 1.5% + 0.5% = ~12%  [index.js]
writeUtf8String               1.8%
hasBinary                     ~3.4%  [is-binary.js]
```

### 실제 동작 (Socket.IO v4.8.1 기준)

`server.to(socketIds).emit(...)` 호출 시 내부 흐름:
```
emit() 호출
  → adapter._encode() (브로드캐스트당 1번)
      → encodeAsString()           ← JSON.stringify (1번)
      → Buffer.from("4" + str)     ← UTF-8 변환 (1번)
      → WebSocket.Sender.frame()   ← WS 프레임 조립 (1번)
      → wsPreEncodedFrame 에 저장
      ↓
      → 소켓 N개 루프
          → sender.sendFrame(wsPreEncodedFrame)  ← 완성된 프레임 그대로 전송, 변환 없음
```

- `encodeAsString` 중복 등장: "소켓마다 N번"이 아니라 **120초 동안 브로드캐스트가 수천 번** 반복된 시간 누적
- UTF-8 변환과 WS 프레임 조립은 이미 브로드캐스트당 1번만 수행됨 (v4.8.1 최적화)
- `writeUtf8String`이 여전히 프로파일에 등장하는 이유: broadcast가 아닌 **per-socket emit** 경로
  - `socket.emit(POSITION_RETRANSMIT_RESPONSE, ...)` — 재전송 요청 응답
  - `client.emit(JOIN_ROOM, ...)` — 입장 시 개별 전송
  - 이쪽은 1:1이라 미리 계산할 필요가 없어 그 자리에서 변환, 단 호출 빈도가 낮아 큰 비중은 아님

### 의미
- 전체 active CPU의 약 21%가 "메시지를 소켓에 쓰는 작업"에 소비됨
- 주 비용은 `encodeAsString` (JSON.stringify 자체의 비용 × 높은 브로드캐스트 빈도)와 `hasBinary` (브로드캐스트마다 재귀 순회)

### 개선 방향: msgpack 파서 교체

`@socket.io/msgpack-parser`를 BE/FE 동시 적용:

| 함수 | 현재 | msgpack 후 |
|-----|------|-----------|
| `encodeAsString` | JSON.stringify (1회) | binary encode (더 빠름) |
| `hasBinary` | 재귀 순회 (1회) | **제거** (항상 binary라 검사 불필요) |
| `writeUtf8String` | string→Buffer 변환 (브로드캐스트당 1번, `Buffer.from("4"+str)`) | binary encode라 UTF-8 변환 자체가 없음 |

```typescript
// BE: gateway 또는 main.ts
import { encode, decode } from '@socket.io/msgpack-parser';
const io = new Server(httpServer, { parser: { encode, decode } });

// FE: socket.ts
import { encode, decode } from '@socket.io/msgpack-parser';
const socket = io(url, { parser: { encode, decode } });
```

> FE/BE 동시 배포 필요 — 파서가 다르면 메시지 파싱 실패

### 의견 정리 
- utf8 나온 김에 한 번 정리하고 들어가도 좋을 듯 
- Socket.io 내 성능 최적화 노력 한 번 정리해도 좋을 듯 (오픈소스 분석)

---

## 핵심 병목 #3 — NestJS ValidationPipe (2.0%)

### 증거
```
getTargetValidationMetadatas  [MetadataStorage.js]   0.6%
transform                     [TransformOperationExecutor.js]  0.6% + 0.2%
getKeys                       [TransformOperationExecutor.js]  0.6%
execute                       [ValidationExecutor.js]          0.4%
```

### 의미
- Socket.IO 이벤트 수신 시마다 class-validator + class-transformer 실행.
- `getTargetValidationMetadatas`는 매 검증마다 메타데이터 맵을 탐색 → 캐시가 없으면 O(n) 반복.
- **position update처럼 초당 수십~수백 번 호출되는 핸들러**에서 이 비용이 누적됨.

### 개선 방향
1. **hot path에서 ValidationPipe 제거**: `updatePosition` 이벤트 핸들러에 `@UsePipes()` 없애거나,
   수동으로 최소한의 타입 체크만 수행.
2. **캐시 활성화**: class-validator의 `skipMissingProperties`, `forbidUnknownValues(false)` 옵션 검토,
   혹은 `cache: true` 옵션 (이미 설정되어 있다면 무의미).

---

## 핵심 병목 #4 — `util.deprecate` 런타임 호출 (1.7%)

### 증거
```
deprecate  [util:146]   0.7% + 0.5% + 0.3% = ~1.7%
```

### 의미
Node.js `util.deprecate()`로 감싼 함수가 요청 처리 경로 안에서 **매번** 호출되고 있음.
`util.deprecate`는 최초 1회만 경고를 출력하지만, 함수 호출 자체의 오버헤드는 매번 발생.
이는 의존성 라이브러리(Socket.IO, ioredis 등)에서 deprecated API를 사용하고 있다는 신호.

### 개선 방향
- `NODE_NO_WARNINGS=1` 환경 변수로 경고 출력 억제 (오버헤드는 크게 줄지 않음).
- 스택 트레이스 확인 후 어떤 경로가 deprecated API를 호출하는지 파악, 대체 API로 교체.
- 주로 ioredis나 Socket.IO의 버전 간 호환성 문제일 가능성이 높음.

---

## 게임 서비스 자체 코드 분석 (2.3%)

```
game-chat.service.js:347         0.6%   704ms
game-room.service.js (updateRoomActivity)  0.4%   526ms
game-session.service.js (updatePosition)   0.4%   491ms
position-broadcast.service.js    0.3%   303ms
game-activity.interceptor.js     0.2%   288ms
game.validator.js                0.2%   228ms
```

**비율 자체는 낮지만**:
- `updateRoomActivity`가 `updatePosition`보다 높다는 점이 눈에 띔.
  position update만큼 자주 호출된다면 Redis 쓰기 최적화 여지 있음.
- `game-chat.service.js:347` — 채팅 처리가 0.6%를 차지.
  채팅은 position에 비해 저빈도이므로, 이 비율이 예상보다 높다면 해당 라인 확인 필요.

---

## 종합 우선순위

| 순위 | 문제 | 예상 절감 | 난이도 |
|-----|------|----------|------|
| 1 | **msgpack 파서 교체** — `writeUtf8String` × 소켓 수 제거, `hasBinary` 제거 | ~15-20% CPU + GC 압박 완화 | 하 (FE/BE 동시 배포) |
| 2 | hot path ValidationPipe 제거 → 1로 통합 | — | — |
| 2 | hot path ValidationPipe 제거 | ~2% CPU + 레이턴시 | 하 |
| 3 | deprecated API 경로 제거 | ~1-2% CPU | 하 |

---

## 사고 방식 — 이런 자료를 어떻게 읽는가

### 1단계: 구조 파악
`.cpuprofile`은 `{ nodes, samples, timeDeltas }` 구조.
- `nodes`: 함수 콜 스택의 각 노드 (callFrame = 파일/함수/라인)
- `samples`: 각 시점에 CPU가 어디 있었는지 (노드 ID)
- `timeDeltas`: 각 샘플 사이의 시간 간격

핵심 계산: **노드별 총 시간 = 해당 노드가 샘플링된 횟수 × 샘플 간격**

### 2단계: Idle/GC를 먼저 분리
- **Idle**: CPU가 실제로 할 일이 없는 시간. 제외하고 "active" 기준으로 재계산.
- **GC**: stop-the-world이므로 단순 오버헤드가 아닌 **레이턴시 스파이크의 직접 원인**.
  GC % > 5%면 메모리 할당 패턴에 문제가 있다고 판단.

### 3단계: 라이브러리 vs 내 코드 분리
파일명으로 분류:
- `index.js`, `is-binary.js`, `socket.js` → Socket.IO 내부
- `MetadataStorage.js`, `TransformOperationExecutor.js` → class-transformer/validator
- `game-*.js`, `batch-*.js` → 직접 작성한 코드

**라이브러리 코드가 상위권을 차지하면** "내 코드가 그 라이브러리를 너무 자주 호출하는 것"이 문제.
라이브러리 자체를 고치려 하면 안 되고, **호출 빈도나 페이로드 크기를 줄이는 방향**으로 접근.

### 4단계: 빈도 × 비용 분해
같은 함수가 여러 샘플 그룹에 나뉘어 나오면 → 호출 빈도가 높다는 신호.
`encodeAsString`이 4개 구간에 분산된 것 = 120초 동안 브로드캐스트가 수천 번 반복된 결과 (소켓당 N번 호출이 아님).
반면 `writeUtf8String`은 broadcast 경로에서는 **브로드캐스트당 1번** — `_encode()`에서 `wsPreEncodedFrame`을 미리 만들고 N개 소켓은 `sendFrame()`으로 그대로 전송. 프로파일에 나타나는 것은 per-socket 1:1 경로(재전송·입장 등) 때문이며, 코드를 확인하기 전까지 "몇 번 호출되는지"를 프로파일만으로 단정하면 안 됨.

### 5단계: 개선 가설 설정
"X를 제거/교체하면 Y% 절감 가능" 형태로 가설 → 실측으로 검증.
프로파일은 **어디서 시간이 쓰이는지**만 알려줌. **왜** 그렇게 됐는지는 코드를 봐야 함.
