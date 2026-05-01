# msgpack 파서 교체 근거

**결론: 바꿔야 한다.**  
세 종류의 독립적인 측정 데이터가 같은 근인을 가리키고 있고, msgpack 교체는 그 근인을 직접 제거한다.

---

## 1. 관찰된 증상

- 부하 테스트 초반에는 캐릭터가 빠르게 움직이다가 **시간이 지날수록 점점 느려짐**
- `[WARN] broadcastRoom took 61ms (>40ms threshold)` 경고 발생
- Active CPU의 **18.7%가 GC**, 정상 범위(< 5%)의 3.7배

---

## 2. 근인 추적 — 세 단계의 증거

### 단계 1. CPU 프로파일 (120초, 부하 테스트 중)

Socket.IO 직렬화 경로가 CPU의 **19.2%** 를 차지한다.

```
encodeAsString (JSON.stringify)   11.3%
hasBinary (payload 재귀 순회)      3.4%
writeUtf8String (string → Buffer)  1.8%
GC (garbage collector)            17.1%
```

두 항목(직렬화 19.2% + GC 17.1%)이 CPU 상위를 차지하지만, 이것은 **두 개의 문제가 아니라 하나의 근인에서 나온 두 증상**이다.

브로드캐스트 1회당 내부 흐름:
```
emit()
  └─ hasBinary(payload)       ← payload 전체 재귀 순회, 중간 배열 생성
  └─ encodeAsString()         ← JSON.stringify → string 생성
  └─ Buffer.from("4" + str)   ← string → Buffer 변환, 즉시 버려짐
  └─ Sender.frame()           ← WS frame 구조체 생성, 즉시 버려짐
```

초당 브로드캐스트 빈도: 위치 이벤트 2회/100ms × 200명 = **초당 ~2,000회**  
120초 기준 생성되는 단수명 Buffer: **24만 개 이상**

### 단계 2. GC 세대 모니터링 (부하 테스트 중)

| 측정값 | 수치 | 의미 |
|---|---|---|
| Minor GC 비율 | **95%** | 객체 대부분이 new space에서 즉시 죽음 = 단수명 Buffer 직접 확인 |
| New space 패턴 | 70% → 2~3% → 30%+ 반복 | Scavenge가 효율적이나 극히 자주 발동 |
| Old space 증가 | **+17 MB** | 일부 객체 승격 누적 → Major GC 유발 |
| Large object space | ~2 MB, 변화 없음 | 큰 객체 1개가 아닌 소형 객체 수십만 개의 문제 |

### 단계 3. `--trace-gc` 실측 (확정)

실측 1,568ms 구간 내 Scavenge **24회**, 평균 **65ms마다 1회**.

가장 결정적인 순간:

```
329461ms  Scavenge  allocation failure  ← new space 꽉 참, 강제 GC
329472ms  Scavenge  allocation failure  ← 11ms 후 또 꽉 참
329484ms  Scavenge  allocation failure  ← 12ms 후 또 꽉 참
329484ms  [WARN] broadcastRoom took 61ms (>40ms threshold)  ← 동일 시점
```

`allocation failure`는 new space가 완전히 소진되어 할당 자체가 불가능해진 상태에서 강제 발동된 Scavenge다.  
6회가 83ms 안에 연속 발생하며 이벤트 루프를 반복적으로 끊었고, 그것이 그대로 `broadcastRoom 61ms`로 나타났다.

순간 최대 할당 속도: **~290 MB/s**

---

## 3. msgpack이 제거하는 것

msgpack은 Binary 인코딩을 사용하므로 JSON 경로의 중간 단계들이 사라진다.

| | JSON (현재) | msgpack |
|---|---|---|
| `hasBinary` | 매 브로드캐스트마다 payload 전체 재귀 순회 | **제거** (항상 binary) |
| `encodeAsString` | JSON.stringify → string 생성 | binary encode |
| `writeUtf8String` | string → Buffer 변환 | **없음** (처음부터 binary) |
| 브로드캐스트당 중간 객체 | string + Buffer + WS frame + 중간 배열 | binary Buffer + WS frame |

브로드캐스트당 생성 객체가 줄어들면:

```
할당 속도 감소
  → Scavenge 발동 빈도 감소 (현재 65ms → 개선)
  → allocation failure 연쇄 발생 빈도 감소
  → Old space 승격 압박 감소
  → Major GC 발동 시점 지연
  → "점점 느려지는" 현상 완화
```

예상 효과: **CPU 15~20% 절감, GC 압박 절반 이하**

---

## 4. 트레이드오프와 대응

### ① 디버깅 어려움

JSON은 WebSocket TEXT frame이라 Chrome DevTools에서 바로 읽힌다.  
msgpack은 BINARY frame이며, DevTools는 msgpack 디코딩을 내장하지 않아 바이트 덩어리로만 보인다.

**대응**: 네트워크 레이어 대신 애플리케이션 레이어에서 로깅한다.  
msgpack-parser가 소켓 핸들러 도달 전에 이미 JS 객체로 변환하므로, `socket.onAny()`에서는 JSON과 동일하게 읽힌다.

```typescript
// FE — 개발 환경에서만 활성화
if (import.meta.env.DEV) {
  socket.onAny((event, ...args) => {
    console.log('[socket in]', event, args);  // 이미 디코딩된 JS 객체
  });
}
```

### ② Rolling deploy 중 클라이언트 충돌

node-1 → node-2 순차 재시작 구조에서, 배포 창 동안 JSON BE ↔ msgpack FE 조합이 발생하면 파싱 실패로 연결이 끊긴다.

**대응**: 배포 시간대를 트래픽 최저점(새벽)으로 잡는다. sticky session이 대부분의 기존 연결을 보호하므로 신규 접속자만 영향을 받는다.

### ③ FE 디코딩 CPU

브라우저의 `JSON.parse`는 네이티브 C++ 구현이라 극도로 최적화되어 있다. 문자열 위주 페이로드에서는 JS 기반 msgpack 디코더보다 빠를 수 있다.

QuizGround의 가장 빈번한 페이로드는 위치 데이터(숫자 위주)이므로 전체적으로는 이득이다. FE 자체가 병목이 아닌 이상 실질적 영향은 없다.

### ④ 나머지

| 항목 | 영향 |
|---|---|
| FE 번들 사이즈 | +~15 KB (gzip ~7 KB), 무시 가능 |
| Socket.IO Admin UI | 배포 전 호환성 확인 필요 |

---

## 5. 전제 조건

- FE/BE **동시 배포** 필수. 파서가 다른 클라이언트-서버 조합은 즉시 파싱 실패.
- MSW mock socket(FE dev 환경)이 msgpack-parser를 통하는 경로인지 확인.

---

## 요약

| 항목 | 내용 |
|---|---|
| 근인 | 브로드캐스트당 단수명 Buffer 대량 생성 |
| 확정 방법 | CPU 프로파일 + GC 모니터링 + `--trace-gc` 3종 독립 측정 일치 |
| 직접 증거 | `allocation failure` 연쇄 6회 = `broadcastRoom 61ms` 동일 시점 |
| msgpack이 제거하는 것 | `hasBinary` 제거 + string→Buffer 변환 단계 제거 |
| 예상 효과 | CPU 15~20% 절감, GC 압박 절반 이하, 진행성 랙 완화 |
| 주요 리스크 | 배포 창 중 연결 끊김 (새벽 배포로 최소화) |
