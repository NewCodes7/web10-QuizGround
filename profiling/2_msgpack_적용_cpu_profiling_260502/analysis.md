# CPU 프로파일 비교 분석: JSON 직렬화 → msgpack 전환

> 기준일: 2026-05-02  
> 기존: `기존_cpu_heap_profiling/cpu-2026-04-30T13-01-56.cpuprofile`  
> 신규: `msgpack_적용_cpu_profiling_260502/cpu-2026-05-02T03-04-05.cpuprofile`

---

## 1. 기본 통계

| 항목 | 기존 (JSON) | msgpack 적용 | 변화 |
|------|------------|--------------|------|
| 총 프로파일 시간 | 120,238ms | 125,755ms | +4.6% |
| 총 샘플 수 | 3,237 | 1,562 | -51.7% |
| 평균 샘플링 간격 | 37.1ms | 80.5ms | +2.2배 |
| 활성 CPU 시간 | 87,958ms (73.2%) | 90,383ms (71.9%) | +2.7% |
| GC 시간 | 20,576ms (17.1%) | 27,585ms (21.9%) | **+34.1%** |
| Idle 시간 | 10,317ms (8.6%) | 4,852ms (3.9%) | -53.0% |

> 샘플 수 차이(3,237 vs 1,562)가 크므로 부하 조건이 달랐을 가능성 있음 — 절대값보다 비율 중심으로 해석 필요.

---

## 2. 직렬화 비용 변화 (핵심)

| 함수 | 기존 (ms / %) | msgpack (ms / %) | 변화 |
|------|--------------|------------------|------|
| `encodeAsString` (socket.io-parser) | 14,080ms (11.7%) | 0ms (0%) | 완전 제거 |
| `hasBinary` (이진 여부 재귀 순회) | 6,366ms (5.3%) | 0ms (0%) | 완전 제거 |
| `_encode` (notepack.io) | 0ms | 6,544ms (5.2%) | 신규 |
| `encode` (notepack.io) | 0ms | 3,264ms (2.6%) | 신규 |
| `Encoder.encode` (socket.io-msgpack-parser) | 0ms | 1,677ms (1.3%) | 신규 |
| `utf8Length` / decode 관련 (notepack.io) | 0ms | 1,263ms (1.0%) | 신규 |
| **직렬화 합계** | **20,857ms (17.3%)** | **12,889ms (10.2%)** | **-38.2%** |
| `writev` (커널 write syscall) | 6,083ms (5.1%) | 2,732ms (2.2%) | -55.1% |

### 가장 극적인 변화: `hasBinary` 완전 제거

JSON 직렬화 방식에서는 모든 소켓 이벤트마다 페이로드를 재귀 순회하여 `Buffer` / `ArrayBuffer` 여부를 검사하는 `hasBinary`(6,366ms, 5.3%)가 실행됐다. msgpack은 바이너리-우선 포맷이므로 이 단계 자체가 불필요해져 완전히 제거됐다.

`writev` 비용이 55% 감소한 것은 msgpack 페이로드가 JSON 문자열보다 작아 커널 write 횟수/크기가 줄어든 효과다.

---

## 3. 기타 주요 함수 변화

| 함수 | 기존 (ms) | msgpack (ms) | 변화 |
|------|----------|--------------|------|
| RxJS 관련 | 5,706ms (4.8%) | 6,596ms (5.3%) | +15.6% |
| socket.io 일반 | 6,916ms (5.8%) | 6,305ms (5.0%) | -8.8% |
| NestJS validation | 2,438ms (2.0%) | 1,687ms (1.3%) | -30.8% |
| Redis 관련 | 3,318ms (2.8%) | 2,605ms (2.1%) | -21.5% |
| `source-map-support` | 1,210ms (1.0%) | 3,944ms (3.1%) | **+226%** |
| `deprecate` (util) | 1,804ms (1.5%) | 3,710ms (3.0%) | +106% |
| `(program)` V8 내부 | 1,387ms (1.2%) | 2,934ms (2.3%) | +112% |
| `updateRoomActivity` | 526ms (0.4%) | 943ms (0.8%) | +79% |

---

## 4. 우려 사항

### GC 시간 증가 (+7,010ms, +34%)

직렬화 절감분(−7,968ms)이 GC 증가분(+7,010ms)에 의해 대부분 상쇄된다.

**원인**: notepack.io가 인코딩 시 내부 버퍼를 동적 확장하며 단명 `Buffer` / `Uint8Array` 객체를 대량 생성한다. 이로 인해 Minor GC(Scavenge) 압력이 상승한다.

**순 절감: ≈ 958ms (0.8%)** — 기대보다 미미하다.

### `source-map-support` 비정상 급증 (+226%)

프로파일링 환경에서 소스맵 변환 비용이 1,210ms → 3,944ms로 증가했다. 프로덕션 빌드에서 `source-map-support`가 활성화되어 있다면 즉시 제거 대상이다.

---

## 5. 결론

msgpack 전환으로 **직렬화 CPU 비용은 38.2% 절감**됐지만, notepack.io의 버퍼 할당 패턴으로 인해 **GC 비용이 34% 증가**하며 실효 이득이 거의 상쇄됐다.

---

## 6. 개선 권고

### (1) `source-map-support` 프로덕션 비활성화 — 즉시 적용 가능

`main.ts`에서 조건 처리하거나 제거. 최소 1,200ms 이상 절감 가능.

```typescript
// 제거 또는 dev 환경에서만 실행
if (process.env.NODE_ENV !== 'production') {
  require('source-map-support').install();
}
```

### (2) notepack.io → `@msgpack/msgpack` 교체 검토

공식 JS 구현(`@msgpack/msgpack`)은 `Encoder` 인스턴스를 재사용할 경우 내부 버퍼를 풀링하여 GC 압력이 낮다.

```typescript
// 싱글턴 Encoder 재사용으로 버퍼 재할당 최소화
import { Encoder, Decoder } from '@msgpack/msgpack';
const encoder = new Encoder();
const decoder = new Decoder();
```

### (3) 동일 부하 조건 재측정 필수

샘플 수 차이(3,237 vs 1,562, 2.1배)가 크므로 k6 등으로 동일 RPS를 걸고 재프로파일링해야 정확한 비교가 가능하다.

### (4) GC 압력 근본 대응

GC가 이미 CPU의 22%를 소비하고 있다. msgpack 최적화와 병행해 `Buffer.allocUnsafe` 풀링, 객체 재사용 패턴 도입이 더 큰 효과를 줄 수 있다.
