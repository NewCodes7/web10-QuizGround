# 200명 부하테스트 병목 분석

**Grafana 대시보드**: [QuizGround - 부하테스트 집중 분석](http://34.158.197.135/grafana/d/quizground-loadtest/1f1b49f5-8511-57ff-8d31-40c4d2b819e9?orgId=1&from=1777076011216&to=1777076387540)

- **테스트 시간**: 2026-04-25 00:13 ~ 00:19 UTC (약 6분)
- **게임방**: 898877 / node1: 101명, node2: 100명 (총 201명)

---

## 지표를 읽는 순서

병목 분석은 "뭐가 죽었나 → 언제부터 죽었나 → 뭐가 죽였나" 순으로 좁혀간다.

---

### Step 1. 부하가 실제로 걸렸는지 확인 — WebSocket 연결 수

```
node1:  0 → 36 → 101명 (00:13:41 ~ 00:13:56)
node2:  1 → 74 → 100명 (00:13:41 ~ 00:13:56)
```

201명이 약 15초 안에 모두 접속. nginx sticky session으로 양 노드에 균등 분산됨.  
이걸 먼저 확인해야 이후 지표가 "진짜 200명 상황"의 데이터임을 신뢰할 수 있다.

---

### Step 2. 사용자 체감 증상 — Socket 레이턴시 P99

| 이벤트 | 부하 전 | 부하 중 |
|---|---|---|
| `retransmitChat` | 0.099s | **0.9s** (히스토그램 상한 포화) |
| `retransmitPosition` | 0.099s | **0.9s** (동일 포화) |
| `updatePosition` | 0.099s | 0.26~0.28s |
| `chatMessage` | 0.099s | 0.26~0.28s |

`retransmit` 이벤트가 발생했다는 것 자체가 **클라이언트가 응답 타임아웃을 치고 재전송 요청을 보낸 것**이다. 정상 시스템에서는 retransmit이 거의 없어야 한다.  
`0.9s`는 히스토그램 최상위 버킷 상한이므로 실제 레이턴시는 그보다 훨씬 높다. 사용자 체감으로는 **위치/채팅이 수 초간 멈추는 상황**이다.

---

### Step 3. 시스템의 핵심 증상 — 이벤트 루프 랙 P99

```
node1: 11ms → 12ms → 17ms → 23ms → 1,737ms → 2,514ms → 4,229ms → 4,999ms → 회복(11ms)
node2: 11ms → 12ms → 19ms → 993ms → 3,491ms → 3,760ms → 756ms → 회복(11ms)
```

대시보드 임계치: yellow=50ms, red=100ms → **최대 5,000ms = red 기준의 50배 초과**.

이벤트 루프 랙이 이 정도면 다른 모든 증상(소켓 지연, retransmit 폭증)은 결과이지 원인이 아니다.  
Node.js가 JavaScript를 5초 동안 yield 없이 실행하고 있다는 의미다.

---

### Step 4. 무엇이 루프를 막는지 — CPU / GC / Position Flush

**CPU 사용률**

```
node1: 2% → 10% → 19% → 30% → 48% → 63% → 74% (지속)
node2: 2% →  9% → 20% → 30% → 54% → 85% → 72%
```

이벤트 루프 랙 곡선과 CPU 곡선이 완전히 일치한다.  
201명 접속 완료 직후부터 CPU가 가파르게 상승하면서 이벤트 루프가 무너진다.  
CPU가 포화되면 Node.js 싱글 스레드가 CPU 타임을 경쟁해 이벤트 루프 회전 자체가 느려진다.

**Position Flush 레이턴시 P99 (gameId 898877)**

```
정상:   9 ~ 17ms
부하 시: 즉시 100ms 히스토그램 상한 포화 (실제값은 100ms 이상)
```

BatchProcessor가 ~16ms마다 flush를 시도하는데, flush 한 번이 100ms+를 소비하면  
다음 flush 주기가 이미 밀린 상태로 시작된다.

**Position Input Queue 크기**: 항상 0  
큐는 비어 있지만 flush가 늦다 = 큐에서 꺼내는 건 순간이지만, **꺼낸 후 처리(Redis 쓰기 + Socket 브로드캐스트)가 이벤트 루프를 블로킹**한다는 뜻이다.

**GC (minor)**

```
node1 minor GC: 0.4ms/s → 19.6ms/s (200명 접속 직후 급등)
node2 minor GC: 0.5ms/s → 18.6ms/s
```

초당 약 17~20ms를 GC가 소비 → GC도 이벤트 루프를 막는 요인이다.  
200명 × 매 tick 위치 업데이트 객체 대량 생성이 young generation을 빠르게 채운다.

**Redis 명령 처리량**

```
평상시: 22 ops/s
부하 중: 1,571 ops/s (접속 직후 피크)
안정 중: ~950 ops/s
```

Redis는 에러 없이 ~950 ops/s를 소화하고 있어 **Redis 자체는 병목이 아니다**.

**소켓 에러율**: updatePosition / chatMessage 모두 0%  
요청이 실패하는 게 아니라 **너무 느린 것**이 문제다.

---

## 병목 원인 체인

```
200명이 동시에 updatePosition 전송
        ↓
BatchProcessor가 ~16ms마다 flush 시도
        ↓
flush 1회당:
  ① 200개 위치 데이터를 Redis에 HMSET
  ② pub/sub publish → 양쪽 WAS가 수신
  ③ socket.io로 방의 모든 클라이언트에 브로드캐스트
        ↓
③번이 핵심: 100명 소켓을 동기 순회하며 직렬화 + 송신 버퍼 적재
→ 이 루프가 이벤트 루프를 수 초간 점유
        ↓
CPU 70~85% 도달 (단일 스레드 포화)
        ↓
이벤트 루프 랙 4,000 ~ 5,000ms
        ↓
클라이언트 응답 타임아웃 → retransmitPosition / retransmitChat 폭증
        ↓
이미 막힌 이벤트 루프에 retransmit 작업까지 적재 (악순환)
```

---

## 병목이 아닌 것

| 지표 | 상태 |
|---|---|
| Redis 자체 | 정상 (0 에러, 950 ops/s 소화) |
| 네트워크 | 소켓 에러율 0% |
| 메모리 | 88MB → 150MB, OOM 없음 |
| Major GC | 미미한 수준 |

---

## 개선 방향

1. **Socket.IO 브로드캐스트 분산**  
   100명을 한 번에 emit하지 않고 배치를 n개씩 `setImmediate`로 분할해 이벤트 루프에 중간 양보

2. **Redis 파이프라인 사용 확인**  
   200개 HMSET을 개별 호출하면 async/await 체인이 이벤트 루프 큐를 과점함

3. **Worker Thread 분리**  
   위치 직렬화·브로드캐스트를 worker thread로 오프로드

4. **GC 압박 완화**  
   위치 업데이트 객체 재사용(object pooling)으로 minor GC 빈도 감소
