# Buffer 가설 — 확정인가, 추론인가

---

## Q1. 버퍼를 없앨 수 있나?

**없앨 수 없다.** WebSocket 프로토콜 자체가 binary frame을 요구한다.  
최종적으로 소켓에 쓰이는 Buffer는 반드시 존재해야 한다.

문제는 Buffer의 존재가 아니라 **브로드캐스트 1회당 생성되는 중간 객체의 수**다.

```
현재 (JSON 경로):
  payload
    → JSON string          ← encodeAsString()
    → "4" + str (중간)     ← Socket.IO 패킷 타입 prefix 붙이기
    → Buffer.from(...)     ← writeUtf8String()
    → WS frame 구조체      ← Sender.frame()
  = 브로드캐스트 1회당 객체 4개, 전부 즉시 버려짐

msgpack 교체 후:
  payload
    → binary Buffer 1개    ← encode()
    → WS frame 구조체
  = 브로드캐스트 1회당 객체 2개 (string→Buffer 변환 단계 없음)
```

**"Buffer를 없앤다"가 아니라 "브로드캐스트당 중간 객체 생성 횟수를 줄인다"가 정확한 방향이다.**

---

## Q2. 버퍼가 문제인 게 확정됐나? Heap에 보이나?

**솔직히 말하면 heap profile에서는 안 보인다.**

heap profile 상위 30개에 `Buffer.from`이나 `writeUtf8String`이 두드러지게 나오지 않는다.  
Socket.IO 런타임 할당은 455 KB로 전체의 3.55%에 불과하다.

이유는 두 가지다.

---

### 이유 1. V8 샘플링 힙 프로파일러의 근본적 한계

```
Buffer 생성 → (수 ms 이내) → Scavenge(Minor GC)가 수거 → 사라짐

샘플링 프로파일러: 일정 KB 할당될 때마다 스냅샷
                        ↑
              이미 수거된 객체는 스냅샷에 없음
```

힙 프로파일러는 **살아있는 객체** 또는 **샘플 시점에 존재하던 객체**를 기록한다.  
Minor GC가 95%라는 측정값은 Buffer들이 너무 빨리 죽어서 샘플링 주기에 잡히기 전에 수거된다는 뜻이기도 하다.

역설: **GC가 잘 작동하기 때문에 heap에 안 보인다.**

힙 샘플링 프로파일러는 **누적이 되는 메모리 문제(leak)**를 찾는 데 적합한 도구다.  
**순간적으로 생겼다 사라지는 객체의 생성 빈도**를 측정하는 데는 맞지 않는 도구다.

---

### 이유 2. 캡처 타이밍 문제

```
현재 파일: Heap.20260501.015518.750499.0.001.heapprofile
                        ↑
                  01시 55분 18초 = 프로세스 기동 직후 캡처

실제 결과: heap 전체 할당의 70.4%가 스타트업 비용 (모듈 로딩)
```

부하 테스트 *중에* 캡처한 게 아니라 프로세스 *기동 직후*에 캡처된 파일이다.  
런타임 브로드캐스트 Buffer들은 이 파일에 거의 담겨 있지 않다.

---

## Q3. 그러면 Buffer 가설의 근거는 무엇인가

직접 증거(heap)는 약하고, 간접 증거들이 수렴한다.

| 증거 | 출처 | 신뢰도 |
|---|---|---|
| `encodeAsString` + `hasBinary` + `writeUtf8String` = CPU 19.2% | CPU 프로파일 | **강** — 실제 실행 시간 측정값 |
| Minor GC 비율 95% | GC 모니터링 | **강** — 단수명 객체가 대량이라는 직접 증거 |
| New space 70%→2% (97~98% 수거율) | GC 모니터링 | **강** — 수거 효율이 극히 높음 = 즉시 죽는 객체들 |
| Old space +17MB (진행성 악화) | GC 모니터링 | **강** — Scavenge 생존 객체의 승격 누적 확인 |
| heap에서 `Buffer.from` 미확인 | heap 프로파일 | **약** — 캡처 타이밍 문제 + 도구 한계 |

**결론: Buffer가 문제라는 가설은 CPU 프로파일 + GC 측정 데이터로 강하게 시사된다.  
그러나 heap profile로 직접 확정된 것은 아니다.**

---

## Q4. 확정하려면 어떻게 해야 하나

부하 테스트 *진행 중*에 아래 중 하나를 수행한다.

### 방법 A — `--trace-gc` 로그 (가장 빠름)

```bash
# ecosystem.config.js node_args에 추가
node_args: "--trace-gc"

# 부하 테스트 후 PM2 로그에서 확인
pm2 logs | grep -E "Scavenge|Mark-Sweep"
```

기대 결과:
- Scavenge가 수 초마다 등장 → Buffer 대량 생성 확인
- 테스트 후반부에 `Mark-Sweep` 빈도 증가 → "점점 느려짐" 원인 확인
- Scavenge가 거의 없다면 Buffer 가설이 틀린 것

### 방법 B — 부하 테스트 *중* heap 재캡처

현재 파일은 기동 직후 캡처라 참고 가치가 낮다.  
200명 부하가 진행 중인 상태에서 캡처하면 `Buffer.from`, `encodeAsString`이 상위에 올라와야 한다.  
그때도 안 올라온다면 Buffer 가설이 틀린 것이다.

---

## 정리

| 질문 | 답 |
|---|---|
| 버퍼를 없앨 수 있나? | 없다. 중간 객체 수를 줄이는 것이 목표 |
| Heap에 Buffer가 보이나? | 안 보인다 |
| 왜 안 보이나? | GC가 너무 빨리 수거 + 캡처 타이밍 잘못됨 |
| Buffer 가설이 확정인가? | 강한 간접 증거들이 있으나, 직접 확정은 아님 |
| 확정 방법? | `--trace-gc` 로 Scavenge 빈도 확인, 또는 부하 중 heap 재캡처 |
