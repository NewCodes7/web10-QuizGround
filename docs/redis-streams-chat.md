# Redis Streams 기반 채팅 설계 문서

> 작성일: 2026-04-14  
> 검토 대상: Codex

---

## 1. 변경 배경

### 기존 방식 (Redis Pub/Sub)
```
클라이언트 → redis.publish('chat:{gameId}') → psubscribe 수신 → BatchProcessor → emit
```
- **에페메랄(ephemeral)**: 메시지가 Redis에 저장되지 않음 — 구독자가 없는 순간 메시지 유실
- **시퀀스 없음**: 클라이언트가 유실 여부를 알 수 없음
- **재전송 불가**: 연결 순단 등으로 메시지를 놓치면 복구 방법 없음

### 새로운 방식 (Redis Streams)
- **내구성**: 메시지가 Stream에 저장 (최대 `CHAT_STREAM_MAXLEN` 개)
- **정렬 보장**: Stream entry ID(타임스탬프 기반)로 자연 정렬
- **시퀀스 번호**: 방 단위 단조 증가 정수 seq — 클라이언트 갭 감지 가능
- **재전송**: 인메모리 배치 로그(CHAT_BATCH_HISTORY_SIZE개) 또는 Stream XRANGE 폴백

---

## 2. 설정값

| 상수 | 값 | 위치 |
|------|-----|------|
| `CHAT_BATCH_TIME` | 50ms | `BE/src/common/constants/batch-time.ts` |
| `CHAT_MAX_TIMERS` | 10 | 위 동일 |
| `CHAT_STREAM_MAXLEN` | 1000 | 위 동일 |
| `CHAT_BATCH_HISTORY_SIZE` | 20 | 위 동일 |

### 설정값 근거

- **CHAT_STREAM_MAXLEN = 1000**: 방당 최근 1000개 메시지를 Redis에 보관. `~` 옵션으로 근사 트림 → 성능 최적화. 메시지 1개 ≈ 500B, 1000개 ≈ 500KB/방.
- **CHAT_BATCH_HISTORY_SIZE = 20**: WAS 인메모리에 최근 20개 배치를 보관. 20 × 50ms = **약 1초** 분량. 재전송 요청이 1초 이내이면 인메모리 조회(빠름), 초과 시 Stream XRANGE 폴백.
- **CHAT_MAX_TIMERS = 10**: PositionBroadcastService와 동일. 방 수가 10개 이하면 1:1 슬롯 할당, 초과 시 라운드로빈으로 같은 슬롯 공유.
- **CHAT_BATCH_TIME = 50ms**: 기존과 동일 유지.

---

## 3. Redis 키

| 키 | 타입 | 목적 |
|----|------|------|
| `Room:{gameId}:Chat` | Stream | 채팅 메시지 영구 저장소 |
| `Room:{gameId}:ChatSeq` | String (int) | 방 단위 단조 증가 시퀀스 |

정리: RoomCleanupSubscriber(30분 TTL) 또는 `cleanupRoom()` 호출 시 두 키 모두 DEL.

---

## 4. 아키텍처

### 4.1 IN Phase (WAS → Redis Streams)

```
클라이언트 chatMessage { gameId, message }
      │
      ▼
GameGateway.handleChatMessage
      │
      ▼
GameChatService.chatMessage()
  ├─ validateRoomExists
  ├─ validatePlayerInRoom
  └─ inputQueue.get(gameId).push({
       playerId, playerName, message,
       timestamp: Date.now(),
       isAlive: player.isAlive          ← 발신 시점 alive 상태 기록
     })

[50ms 타이머 슬롯 - Phase 1]
  ├─ localQueue.splice()               ← 큐 드레인
  ├─ pipeline.xadd(Room:{gameId}:Chat, *, field=value...)  × N
  └─ pipeline.xtrim(MAXLEN ~ 1000)     ← 근사 트림
```

### 4.2 OUT Phase (Redis Streams → 클라이언트)

```
[50ms 타이머 슬롯 - Phase 2 (Phase 1 직후)]
  ├─ XRANGE Room:{gameId}:Chat (lastStreamId +
  │         (exclusive range, Redis 6.2+)
  ├─ entries가 있으면:
  │    ├─ INCR Room:{gameId}:ChatSeq  → seq
  │    ├─ batchLogMap 업데이트 (최대 20개)
  │    ├─ alive 발신 메시지 → server.to(gameId).emit('chatMessage', {seq, messages})
  │    └─ dead 발신 메시지  → dead 소켓들에 개별 emit
  └─ lastStreamId 갱신
```

### 4.3 Retransmit

```
클라이언트가 gap 감지 (seq 건너뜀)
  └─ emit('retransmitChat', { gameId, lastSeq })

GameGateway.handleRetransmitChat
  └─ GameChatService.handleRetransmit()
       ├─ 플레이어 검증 (gameId 일치, 방 멤버 확인)
       ├─ INCR ChatSeq 현재값 조회
       ├─ batchLogMap에서 seq > lastSeq 항목 조회
       │    HIT  → 해당 메시지 필터링(alive 요청자는 alive 발신 메시지만)
       │    MISS → XRANGE 전체 스캔 (isFallback=true)
       └─ emit('chatRetransmitResponse', { seq, messages, isFallback })
```

---

## 5. 클라이언트 측 동작 (FE)

```typescript
// socketListener.ts

const chatSeqMap = new Map<string, number>();      // gameId → lastSeq
const chatRetransmitPending = new Set<string>();   // 중복 요청 방지

on('chatMessage', (data) => {
  if (isNewFormat(data)) {                         // { seq, messages }
    // gap 감지
    if (last > 0 && seq > last + 1 && !pending) {
      pending.add(gameId);
      emit('retransmitChat', { gameId, lastSeq: last });
    }
    chatSeqMap.set(gameId, seq);
    addMessages(messages);
  }
});

on('chatRetransmitResponse', (data) => {
  pending.delete(gameId);
  chatSeqMap.set(gameId, max(last, data.seq));
  addMessages(data.messages);
});
```

---

## 6. alive/dead 분리 방송 로직 (기존 유지)

| 발신자 | 수신자 |
|--------|--------|
| alive (isAlive=1) | 방 전체 (`server.to(gameId).emit`) |
| dead (isAlive=0) | dead 플레이어만 (소켓 개별 emit) |

isAlive는 `chatMessage()` 호출 시점에 Redis에서 읽어 인메모리 큐에 저장.

---

## 7. 타이머 슬롯 패턴

PositionBroadcastService와 동일한 `TimerSlot[]` 구조:

```
CHAT_MAX_TIMERS = 10 슬롯
각 슬롯 offset = 50ms / 10 = 5ms
슬롯 0: delay 0ms  후 50ms 간격으로 flushSlot(0)
슬롯 1: delay 5ms  후 50ms 간격으로 flushSlot(1)
...
슬롯 9: delay 45ms 후 50ms 간격으로 flushSlot(9)

방 배정: round-robin. 방 N → 슬롯 N % 10
방이 10개 이하 → 방당 독립 슬롯
방이 11개 이상 → 슬롯 공유 (WARN 로그)
```

---

## 8. 수정 파일 목록

### Backend

| 파일 | 변경 내용 |
|------|-----------|
| `BE/src/game/service/game.chat.service.ts` | 전면 리팩토링 (Pub/Sub → Streams) |
| `BE/src/game/service/game.room.service.ts` | `onRoomJoined/Left` 추가 호출 |
| `BE/src/game/game.gateway.ts` | `RETRANSMIT_CHAT` 핸들러, `initTimers` 호출 |
| `BE/src/game/game.module.ts` | `BatchProcessor` 제거 |
| `BE/src/common/constants/redis-key.constant.ts` | `ROOM_CHAT_STREAM`, `ROOM_CHAT_SEQ` 추가 |
| `BE/src/common/constants/batch-time.ts` | 채팅 관련 상수 추가 |
| `BE/src/common/constants/socket-events.ts` | `RETRANSMIT_CHAT`, `CHAT_RETRANSMIT_RESPONSE` 추가 |
| `BE/src/game/dto/retransmit-chat.dto.ts` | 신규 생성 |

### Frontend

| 파일 | 변경 내용 |
|------|-----------|
| `FE/src/constants/socketEvents.ts` | 새 이벤트 상수 추가 |
| `FE/src/api/socket/socketEventTypes.ts` | `ChatBatchResponse` 등 타입 추가 |
| `FE/src/features/game/data/socketListener.ts` | gap 감지 + retransmit 로직 |
| `FE/src/features/game/data/store/useChatStore.ts` | `addMessages` 배치 메서드 추가 |

---

## 9. 검증 방법

```bash
# 1. 단위 테스트
cd BE && npm run test -- game.chat

# 2. 통합 테스트
cd BE && npm run test:integration

# 3. Redis CLI로 스트림 확인 (게임방 입장 후)
XLEN Room:123456:Chat           # 메시지 수
XRANGE Room:123456:Chat - +     # 전체 메시지 조회
GET Room:123456:ChatSeq         # 현재 seq
```

### 수동 시나리오

1. 두 브라우저 탭에서 같은 방 입장
2. 채팅 전송 → 양쪽에서 배치로 수신 확인
3. 탭 하나를 네트워크 차단 → 몇 초 후 복원 → 재전송 요청 발생 확인 (DevTools Network)
4. Survival 모드: dead 플레이어 채팅이 alive 플레이어에게 보이지 않는지 확인

---

## 10. 제약사항 및 주의사항

- **배타적 XRANGE (`(id`)**: **Redis 6.2+ 필수**. 이하 버전에서는 `XRANGE` 명령에 `(id` 문법이 지원되지 않아 syntax error 발생. 운영 환경 Redis 버전을 반드시 확인할 것. (`redis-cli INFO server | grep redis_version`)
- **단일 WAS 가정**: 채팅 Stream은 이 WAS 인스턴스만 씀. 다중 WAS 확장 시 Consumer Groups + Socket.IO Redis Adapter 필요.
- **인메모리 큐 유실**: WAS 재시작 시 inputQueue에 있던 메시지는 유실. 재시작 전 미전송 메시지는 복구 불가 (게임 세션 특성상 허용 범위).
