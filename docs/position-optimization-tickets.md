# 캐릭터 위치 전송 최적화 후속 티켓

## 목적

커밋 `c9c6831262ee7b6a3a8022f5afe1718b279a1a8f` 리뷰 결과를 바탕으로, 위험도가 높은 문제를 먼저 해소하고 이후에 Redis Pub/Sub 기반 위치 전송 최적화를 요구사항에 맞게 완성하기 위한 작업 티켓을 정리한다.

우선순위는 다음 기준으로 잡는다.

- 보안 및 정보 노출 방지
- 게임 규칙 회귀 방지
- 멀티 서버 환경에서의 일관성 확보
- Redis 부하 절감
- 테스트 보강

## 작업 순서

1. 재전송 권한 검증
2. 재전송 visibility 규칙 정리
3. 서버 입력 배치 도입
4. Redis authoritative seq 도입
5. Lua 기반 write + seq + publish 원자화
6. seq 기반 재전송 로그 저장 구조 도입
7. 테스트 및 관측 보강

## 티켓 목록

### TICKET-001 재전송 요청 권한 검증 추가

**문제**

- 현재 `retransmitPosition`은 클라이언트가 보낸 `gameId`를 그대로 사용한다.
- 같은 네임스페이스에 접속한 다른 클라이언트가 임의의 방 위치를 조회할 수 있다.

**작업**

- `client.data.playerId` 기준으로 현재 플레이어의 `gameId`를 Redis에서 조회한다.
- 요청 DTO의 `gameId`와 실제 소속 방이 다르면 예외를 반환한다.
- 플레이어가 방에 속하지 않은 경우도 예외를 반환한다.
- `lastSeq`에 대한 하한 검증도 추가한다.

**완료 조건**

- 다른 방 `gameId`로 재전송 요청 시 실패한다.
- 정상 사용자는 자기 방에 대해서만 재전송 요청이 가능하다.
- 관련 예외가 기존 WebSocket 예외 포맷으로 내려간다.

**영향 범위**

- `BE/src/game/game.gateway.ts`
- `BE/src/game/service/position-broadcast.service.ts`
- 필요 시 validator 계층

---

### TICKET-002 재전송 응답의 alive/dead visibility 규칙 정리

**문제**

- 현재 재전송은 요청자 상태와 무관하게 현재 위치를 조회해 응답한다.
- alive 플레이어에게 dead 플레이어 위치가 노출될 수 있다.
- 기존 브로드캐스트 규칙과 재전송 규칙이 다르다.

**작업**

- 요청자 플레이어의 `isAlive`를 기준으로 재전송 응답 필터링 정책을 정의한다.
- alive 요청자에게는 alive 플레이어 위치만 재전송한다.
- dead 요청자에게는 기존 브로드캐스트 정책과 동일한 범위로 재전송한다.
- 정책을 코드 주석 또는 문서에 명시한다.

**완료 조건**

- alive 요청자는 dead 위치를 받지 않는다.
- dead 요청자는 현재 게임 규칙에 맞는 위치 집합만 받는다.
- 일반 브로드캐스트와 재전송 간 가시성 정책이 일치한다.

**영향 범위**

- `BE/src/game/service/position-broadcast.service.ts`
- 필요 시 FE stale update 처리 확인

---

### TICKET-003 서버 측 위치 입력 배치 큐 도입

**문제**

- 현재 위치 업데이트 빈도 제어를 FE `50ms throttle`에 의존한다.
- 클라이언트가 throttle을 우회하면 서버와 Redis에 부하가 그대로 유입된다.
- 요구사항의 “각 서버마다 50ms 단위 publish”가 구현되지 않았다.

**작업**

- 서버 로컬 메모리에 방 단위 position input queue를 둔다.
- `updatePosition` 호출 시 Redis 즉시 write/publish 대신 큐에 적재한다.
- 50ms마다 방 단위 또는 슬롯 단위로 큐를 flush한다.
- 동일 플레이어의 중복 업데이트는 마지막 위치만 남기도록 덮어쓰기 전략을 검토한다.

**완료 조건**

- `updatePosition` 호출 빈도와 무관하게 Redis publish는 서버 배치 주기 기준으로만 발생한다.
- 한 플레이어가 50ms 내 여러 번 움직이면 마지막 위치만 반영되는지 명확하다.
- FE throttle이 없어도 서버가 폭주를 직접 완화할 수 있다.

**영향 범위**

- `BE/src/game/service/game.service.ts`
- 신규 또는 기존 배치 서비스
- 메트릭 수집 로직

---

### TICKET-004 방 단위 authoritative seq를 Redis로 이동

**문제**

- 현재 `roomSeq`는 서버 메모리에 있다.
- 서버 재시작, 재구독, 멀티 인스턴스 환경에서 seq 기준이 깨질 수 있다.

**작업**

- 방 단위 seq를 Redis key로 관리한다.
- 브로드캐스트 시 seq 증가를 Redis 기준으로만 수행한다.
- 서버 로컬 메모리의 `roomSeq`는 제거하거나 캐시 전용으로 축소한다.
- seq 초기화 시점과 방 종료 시 정리 정책을 정의한다.

**완료 조건**

- 여러 서버가 같은 방을 처리해도 seq가 단조 증가한다.
- 서버 재시작 후에도 이전 seq 기준이 유지된다.
- 재전송 요청의 `lastSeq` 판단 기준이 서버별로 달라지지 않는다.

**영향 범위**

- `BE/src/game/service/position-broadcast.service.ts`
- Redis key constants

---

### TICKET-005 Lua로 위치 반영 + seq 발급 + publish 원자화

**문제**

- 현재 `pipeline(HMSET + PUBLISH)`는 네트워크 왕복은 줄여도 원자성을 보장하지 않는다.
- 요구사항의 “배치 단위 Redis pub/sub + 플레이어 위치 쓰기를 lua로 반영”이 빠져 있다.

**작업**

- Lua script 또는 `EVALSHA`를 사용해 다음을 한 번에 처리한다.
- 플레이어 위치 반영
- 방 단위 seq 증가
- 배치 payload publish
- 필요 시 최근 배치 로그 저장
- 실패 시 재시도/에러 로깅 전략을 정의한다.

**완료 조건**

- write, seq, publish가 하나의 Redis 연산 단위로 처리된다.
- 부분 성공으로 인한 상태 불일치가 제거된다.
- 배치 payload 구조가 FE 재전송 요구사항을 만족한다.

**영향 범위**

- 배치 flush 경로 전체
- Redis script 관리 코드

---

### TICKET-006 seq 기반 재전송 로그 저장소 설계 및 구현

**문제**

- 현재 재전송은 누락된 배치를 재생하는 것이 아니라 “현재 위치 스냅샷” 조회에 가깝다.
- 요구사항의 “시퀀스 번호 기반 재전송”이 엄밀하게 구현되지 않았다.

**작업**

- 최근 N개 배치 로그를 Redis에 저장하는 구조를 도입한다.
- 후보:
  - Redis List
  - Redis Stream
  - seq별 hash/string payload
- 재전송 요청 시 `lastSeq + 1`부터 현재 seq까지의 배치를 조회한다.
- 로그 범위 밖이면 전체 스냅샷 fallback으로 전환한다.
- fallback 시에도 alive/dead visibility 규칙을 적용한다.

**완료 조건**

- seq gap이 나면 실제 누락된 배치 범위만 재전송할 수 있다.
- 로그 범위 밖 fallback 정책이 명확하다.
- 현재 스냅샷 fallback 여부가 응답 payload에서 구분 가능하다.

**영향 범위**

- `BE/src/game/service/position-broadcast.service.ts`
- Redis key/constants
- FE retransmit response 처리

---

### TICKET-007 방별 브로드캐스트 스케줄러 구조 정리

**문제**

- 현재 10개 슬롯 라운드로빈은 들어가 있지만, 방 수 증가 시 부하 분산 전략과 타이머 관리 기준이 충분히 명시돼 있지 않다.
- 요구사항의 “offset 분산”과 “타이머 개수 상한 이후에는 한 타이머에 여러 방 배치 전송”을 더 명확히 구조화할 필요가 있다.

**작업**

- 슬롯 수, offset 간격, 방 배정 전략을 명시한다.
- 방 수가 슬롯 수를 넘는 경우 슬롯당 다수 방 flush 정책을 문서화한다.
- flush 도중 오래 걸리는 방 때문에 다른 방이 밀리는지 측정 포인트를 추가한다.
- 구독 시작/종료 시 slot assignment가 누수 없이 정리되는지 보장한다.

**완료 조건**

- 방 수가 늘어도 timer 개수는 상한 내에서 유지된다.
- 특정 슬롯에 방이 몰릴 때의 동작이 예측 가능하다.
- room join/leave 후 slot과 subscriber 누수가 없다.

**영향 범위**

- `BE/src/game/service/position-broadcast.service.ts`

---

### TICKET-008 FE seq gap 처리와 stale update 방어 보강

**문제**

- 현재 FE는 gap 감지 후 재전송을 요청하지만, 중복 요청과 응답 순서 역전 상황에 대한 방어가 제한적이다.
- 방 이동 또는 재입장 시 seq 상태 초기화 타이밍도 명확하지 않다.

**작업**

- 방 단위 재전송 요청 중복 방지 상태를 둔다.
- 동일 gap에 대한 연속 요청을 제한한다.
- 방 퇴장, 재입장, disconnect 시 seq 상태 초기화 시점을 정리한다.
- stale update 무시 기준을 payload 계약과 맞춘다.

**완료 조건**

- gap이 발생해도 재전송 요청이 과도하게 반복되지 않는다.
- 재전송 응답이 늦게 와도 더 최신 업데이트를 덮어쓰지 않는다.
- 방 전환 후 이전 방 seq 상태가 남지 않는다.

**영향 범위**

- `FE/src/features/game/data/socketListener.ts`
- 필요 시 socket type definitions

---

### TICKET-009 통합 테스트 및 멀티 인스턴스 시나리오 보강

**문제**

- 현재 테스트는 응답 포맷 적응 수준이며, 새로 추가된 핵심 복잡도를 거의 검증하지 않는다.

**작업**

- BE 통합 테스트 추가
- 시나리오:
  - 정상 배치 브로드캐스트
  - seq gap 발생 후 재전송
  - 다른 방 `gameId` 재전송 요청 차단
  - alive/dead visibility 검증
  - 히스토리 범위 밖 fallback
  - 방 입퇴장 반복 후 subscriber/timer cleanup
- 가능하면 멀티 인스턴스 또는 최소한 pub/sub 복수 subscriber 시나리오도 추가한다.

**완료 조건**

- 위험 시나리오가 자동 테스트로 재현 가능하다.
- 새 구현이 기존 게임 흐름을 깨지 않는다는 최소 안전망이 생긴다.

**영향 범위**

- `BE/test/integration/game/`
- 필요 시 FE socket listener 단위 테스트

---

### TICKET-010 운영 메트릭 및 디버깅 포인트 추가

**문제**

- 최적화 후 성능 개선 여부와 장애 원인을 운영에서 확인하기 어렵다.

**작업**

- 메트릭 추가
- 후보:
  - 방별 input queue 길이
  - flush당 update 수
  - retransmit 요청 횟수
  - fallback retransmit 횟수
  - seq gap 감지 횟수
  - slot별 flush 소요 시간
- 경고 로그 기준을 정한다.

**완료 조건**

- Redis 부하 감소와 gap 발생률을 수치로 볼 수 있다.
- 특정 방이나 특정 서버에서만 문제가 생기는지 추적 가능하다.

**영향 범위**

- `BE/src/game/service/position-broadcast.service.ts`
- metric service

## 추천 마일스톤

### Milestone 1 안전성 복구

- TICKET-001
- TICKET-002
- TICKET-009 일부

목표: 정보 노출과 규칙 회귀를 먼저 막는다.

### Milestone 2 요구사항 정합성 확보

- TICKET-003
- TICKET-004
- TICKET-005

목표: 서버 측 배치와 Redis 원자화를 실제 요구사항대로 구현한다.

### Milestone 3 재전송 완성도 향상

- TICKET-006
- TICKET-008
- TICKET-009 나머지

목표: seq 기반 재전송을 신뢰 가능한 형태로 완성한다.

### Milestone 4 운영 최적화

- TICKET-007
- TICKET-010

목표: 방 수 증가와 운영 관측까지 포함해 안정화한다.

## 비고

- 구현 전에 재전송 payload 계약을 먼저 확정하는 것이 좋다.
- alive/dead visibility 정책은 게임 규칙 문서와 함께 명시해야 FE/BE가 다르게 구현되지 않는다.
- “현재 위치 스냅샷 fallback”은 편의 기능으로 두되, 기본 경로는 반드시 “seq 범위 재전송”이 되도록 설계하는 편이 안전하다.
