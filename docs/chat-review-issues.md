# Redis Streams 채팅 구현 — 코드리뷰 이슈 목록

> 작성일: 2026-04-14  
> 대상 커밋: 현재 워킹트리 변경사항 (main 브랜치 미커밋)  
> 리뷰 범위: `BE/src/game/service/game.chat.service.ts` 전면 리팩토링 외 관련 파일

---

## 이슈 목록

| # | 심각도 | 상태 | 제목 |
|---|--------|------|------|
| 1 | 🔴 Critical | ✅ done | TOCTOU 락 해제 버그 — 타 WAS 락을 날릴 수 있음 |
| 2 | 🔴 Critical | ✅ done | Dead 전용 배치에서 Alive 클라이언트 seq 갭 폭풍 |
| 3 | 🔴 High | ✅ done | `broadcastToDeadPlayers` — 다른 WAS 연결 클라이언트 유실 |
| 4 | 🟠 High | ✅ done | `persistRoom` — insert 성공 + cursor 갱신 실패 시 중복 저장 |
| 5 | 🟠 High | ✅ done | 분산 WAS에서 chatMessage silently dropped (Pub/Sub 대비 퇴보) |
| 6 | 🟠 Medium | ✅ done | Redis 6.2+ 전용 exclusive XRANGE 사용 |
| 7 | 🟡 Low | ✅ done | `BatchProcessor` 파일 미삭제 (데드코드) |
| 8 | 🟡 Low | ✅ done | XTRIM 직후 XRANGE — 극단적 trim race로 메시지 유실 가능 |
| 9 | 🟡 Low | ✅ done | retransmit 폴백 전체 XRANGE 스캔 — 동시 다중 요청 시 Redis 부하 |
| 10 | 🟡 Low | ✅ done | `onRoomJoined`/`onRoomLeft` 카운트 불균형 → 인메모리 누수 가능 |

---

## 상세 설명

---

### Issue 1 🔴 — TOCTOU 락 해제 버그

**파일**: `BE/src/game/service/game.chat.service.ts` — `persistRoom()` finally 블록

**현재 코드**:
```typescript
const owner = await this.redis.get(lockKey);   // GET
if (owner === this.instanceId) {
  await this.redis.del(lockKey);               // DEL — GET과 DEL 사이에 TTL 만료 가능
}
```

**문제**: `GET`과 `DEL` 사이에 락 TTL(70s)이 만료되면, 다른 WAS가 락을 새로 획득할 수 있음.
이 시점에 원래 WAS가 `DEL`을 실행하면 다른 WAS의 락을 날려버려 중복 저장이 발생함.

**해결책**: Lua 스크립트로 GET+DEL을 원자적으로 처리:
```lua
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end
```

---

### Issue 2 🔴 — Dead 전용 배치 seq 갭 폭풍

**파일**: `BE/src/game/service/game.chat.service.ts` — `flushRoom()` Phase 2

**문제**: `seq`는 배치 내 메시지가 존재하면 항상 INCR됨.
dead 플레이어만 채팅한 배치에서는 seq가 올라가지만 alive 클라이언트는 해당 배치를 수신하지 못함.

FE `chatSeqMap`에서 `seq > last + 1`을 갭으로 판단해 `retransmitChat`을 요청 →
서버에서 응답해도 다음 dead 전용 배치에서 또 갭 감지 → 무한 반복.

**해결책**: alive 클라이언트에게 emit하는 seq와 dead 클라이언트에게 emit하는 seq를 분리하거나,
dead 전용 배치에는 seq를 발급하지 않고 별도 채널로 전송.

---

### Issue 3 🔴 — `broadcastToDeadPlayers` 다른 WAS 클라이언트 유실

**파일**: `BE/src/game/service/game.chat.service.ts` — `broadcastToDeadPlayers()`

**현재 코드**:
```typescript
const socket = this.server.sockets.get(p.socketId);
if (socket) {
  socket.emit(...);
}
```

**문제**: `this.server.sockets`는 현재 WAS 인스턴스의 로컬 소켓 맵.
다른 WAS에 연결된 dead 플레이어는 Redis에 socketId가 있어도 로컬 맵에서 찾을 수 없어 메시지 유실.

**해결책 (단기)**: dead 플레이어도 room 소켓 room에 남겨두고 `server.to(gameId).emit`으로 전송,
FE에서 alive/dead 상태를 기준으로 렌더링 필터링. 또는 Socket.IO Redis Adapter 도입.

---

### Issue 4 🟠 — `persistRoom` insert+cursor 원자성 부재

**파일**: `BE/src/game/service/game.chat.service.ts` — `persistRoom()`

**문제**:
```typescript
await this.chatMessageRepository.insert(rows);     // 성공
await this.redis.set(cursorKey, newCursor);        // 실패 → 예외
// finally에서 락 해제 → 다음 주기에 같은 rows를 재삽입
```
`insert` 성공 후 `redis.set(cursor)` 실패 시, 다음 주기에 중복 삽입.
`ChatMessageModel`에 DB 레벨 unique constraint 없어 중복이 그대로 저장됨.

**해결책**: `chatMessageRepository.insert` 시 stream entry ID를 `externalId` 컬럼으로 저장하고
unique constraint 추가 (ON CONFLICT IGNORE). 또는 cursor 갱신을 insert 트랜잭션 이전에 처리.

---

### Issue 5 🟠 — 분산 WAS에서 chatMessage silently dropped

**파일**: `BE/src/game/service/game.chat.service.ts` — `chatMessage()`

**문제**:
```typescript
const queue = this.inputQueue.get(gameId);
if (!queue) {
  this.logger.warn(`room ${gameId} not active on this server — dropped`);
  return;  // 클라이언트에 오류 응답 없음
}
```
`inputQueue`는 WAS 로컬 인메모리. Socket.IO 라우팅으로 다른 WAS에 소켓이 맺어진 경우 채팅 메시지 소실.
기존 Redis Pub/Sub 방식은 이 문제가 없었으므로 분산 환경 대비 퇴보.

**해결책**: 큐가 없을 때 `GameWsException`을 throw해 클라이언트가 인지하도록.
근본 해결은 Socket.IO Redis Adapter + Consumer Groups 도입.

---

### Issue 6 🟠 — Redis 6.2+ 전용 exclusive XRANGE

**파일**: `BE/src/game/service/game.chat.service.ts` — `flushRoom()`

**현재 코드**:
```typescript
const start = lastStreamId === '0-0' ? '-' : `(${lastStreamId}`;
await this.redis.xrange(streamKey, start, '+');
```

**문제**: XRANGE exclusive 범위(`(id` 문법)는 Redis 6.2+에서만 지원.
이하 버전에서는 오류 또는 undefined 동작.

**해결책**: Redis 버전 확인 후 6.2 미만이면 inclusive range로 fallback + 중복 항목 필터링.
또는 XREAD (lastId 이후를 exclusive로 읽는 표준 명령어) 사용 고려.

---

### Issue 7 🟡 — `BatchProcessor` 데드코드

**파일**: `BE/src/game/service/batch.processor.ts`

**문제**: `game.module.ts`에서 provider로 제거됐지만 파일이 남아있음.
더 이상 어디서도 import/inject되지 않는 데드코드.

**해결책**: 파일 삭제.

---

### Issue 8 🟡 — XTRIM + XRANGE 사이 극단적 trim race

**파일**: `BE/src/game/service/game.chat.service.ts` — `flushRoom()` Phase 1→2

**문제**: 근사 트림(`~`) 후 바로 XRANGE로 읽는 구조. 스트림이 MAXLEN(1000) 근처에 있을 때,
방금 쓴 항목이 트림되면 Phase 2의 XRANGE에서 읽지 못해 메시지가 영구 유실될 수 있음.
발생 빈도는 낮으나 근사 트림의 특성상 이론적으로 가능.

**해결책**: XTRIM을 Phase 2 (broadcast) 이후로 이동하거나, 정확 트림(`MAXLEN` without `~`)으로 변경.
또는 XADD에서 `MAXLEN ~` 옵션을 직접 지정해 별도 XTRIM 제거.

---

### Issue 9 🟡 — retransmit 폴백 전체 XRANGE 동시 다중 요청

**파일**: `BE/src/game/service/game.chat.service.ts` — `handleRetransmit()`

**문제**:
```typescript
const entries = await this.redis.xrange(streamKey, '-', '+');  // 최대 1000개
```
네트워크 순단 후 다수 클라이언트가 동시에 retransmit 요청 시, 동시다발 전체 스캔 발생.
`COUNT` 제한 없음.

**해결책**: `XRANGE ... COUNT N`으로 제한 추가. 또는 XREVRANGE로 최근 N개만 읽기.

---

### Issue 10 🟡 — `onRoomJoined`/`onRoomLeft` 카운트 불균형

**파일**: `BE/src/game/service/game.room.service.ts` — `joinRoom()`, `handlePlayerExit()`

**문제**: `joinRoom()` 내 예외 발생 시 `onRoomJoined`가 호출된 후 `onRoomLeft` 없이 종료될 수 있음.
`localClientCounts` 과다계상 → `cleanupRoom`이 호출되지 않아 인메모리 맵 + Redis 키 누수.

**해결책**: `joinRoom()`에서 `onRoomJoined` 호출 전후로 try/catch 처리.
또는 `onRoomJoined` 호출을 join 성공 확정 이후(Redis hset 완료 시점)로 이동.
