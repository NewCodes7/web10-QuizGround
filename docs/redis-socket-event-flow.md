# Redis × Socket 이벤트 흐름 문서

> 분산 WAS 환경에서 각 소켓 이벤트가 Redis를 통해 어떤 흐름으로 처리·응답되는지 정리한다.

---

## 먼저 읽어야 할 것: 위치(Position)와 채팅(Chat)

위치 업데이트와 채팅 메시지는 **다른 이벤트와 처리 방식이 근본적으로 다르다**.  
대부분의 이벤트는 요청 → Redis 기록 → Keyspace Notification → 브로드캐스트의 동기적 흐름을 따르지만,  
이 두 가지는 **50ms 슬롯 기반 배치 버퍼**를 거쳐 비동기로 흐른다.

### 배치 타이머 구조 (공통)

```
IN 타이머  (0, 5, 10 ... 45ms 오프셋, 10슬롯)
  └─ 로컬 인메모리 큐 → Redis 기록

OUT 타이머 (IN + 25ms 지연)
  └─ Redis에서 읽어서 Socket.IO broadcast
```

- **IN/OUT 분리 이유**: IN이 Redis에 쓰는 것이 완료된 이후에 OUT이 읽도록 보장
- 각 슬롯은 특정 gameId를 담당하며 라운드로빈으로 배정됨
- 서버 로컬 상태(`localClientCounts`, `inputQueue`, `pendingBroadcasts`, `batchLogMap`)를 유지

### 위치 업데이트 특이사항

- 같은 배치 윈도 내에서 동일 플레이어의 위치가 여러 번 오면 **마지막 값만** Redis에 기록 (overwrite)
- **Lua 스크립트**로 `INCR` + `HMSET` + `RPUSH` + `PUBLISH`를 원자적으로 실행
- `position:{gameId}` pub/sub 채널로 배치를 PUBLISH → 다른 WAS 인스턴스가 SUBSCRIBE해서 자신의 로컬 클라이언트에게 emit
- `serverId`로 자기 자신이 publish한 메시지를 필터링 → 같은 WAS에서 이중 broadcast 방지
- 사망자 위치는 개별 socketId를 통해 사망자 클라이언트에만 emit (생존자 룸 브로드캐스트와 분리)

### 채팅 특이사항

- **Redis Streams** (`XADD`, `XRANGE`)로 최대 1000개 메시지를 내구성 있게 저장
- 생존자↔사망자 **가시성 필터**: 살아있는 플레이어는 생존자 메시지만, 사망 플레이어는 전체 메시지를 수신
- MySQL 영속화는 분산 락(`ChatPersistLock`, NX EX 70s)으로 한 WAS만 담당

---

## Redis 키 패턴 한눈에 보기

| 키 패턴 | 타입 | 주요 용도 |
|---|---|---|
| `Room:{gameId}` | HASH | 방 설정, 상태, 호스트 |
| `Room:{gameId}:Players` | SET | 참가자 playerId 목록 |
| `Room:{gameId}:Leaderboard` | ZSET | 플레이어 점수 |
| `Room:{gameId}:Seq` | STRING | 위치 배치 시퀀스 번호 |
| `Room:{gameId}:PositionLog` | LIST | 최근 위치 배치 JSON (최대 20) |
| `Room:{gameId}:Chat` | STREAM | 채팅 메시지 (MAXLEN ~1000) |
| `Room:{gameId}:ChatSeq` | STRING | 채팅 배치 시퀀스 번호 |
| `Room:{gameId}:ChatPersistLock` | STRING | MySQL 영속화 분산 락 (TTL 70s) |
| `Room:{gameId}:ChatPersistCursor` | STRING | 마지막 영속화된 스트림 ID |
| `Room:{gameId}:Quiz:{quizId}` | HASH | 퀴즈 메타데이터 |
| `Room:{gameId}:Quiz:{quizId}:Choices` | HASH | 퀴즈 선택지 |
| `Room:{gameId}:QuizSet` | SET | 게임에 사용될 퀴즈 ID 목록 |
| `Room:{gameId}:CurrentQuiz` | STRING | 퀴즈 상태머신 (`{num}:start\|end`) |
| `Room:{gameId}:Timer` | STRING | TTL 만료로 퀴즈 전환 트리거 |
| `Room:{gameId}:ScoringStatus` | STRING | 채점 중복 방지 락 |
| `Room:{gameId}:ScoringCount` | STRING | 채점 완료 클라이언트 카운트 |
| `Room:{gameId}:Changes` | STRING | 방 상태 변경 종류 마커 |
| `Player:{playerId}` | HASH | 플레이어 상태 (위치, 이름, 생존 여부 등) |
| `Player:{playerId}:Changes` | STRING | 플레이어 변경 종류 마커 |
| `ActiveRooms` | SET | 전체 활성 방 ID |
| `position:{gameId}` | Channel | 위치 배치 pub/sub (멀티 WAS 예약) |
| `scoring:{gameId}` | Channel | 채점 완료 pub/sub |
| `room:cleanup` | Channel | 방 삭제 트리거 pub/sub |

---

## 공통 패턴: Changes 마커 + Keyspace Notification

위치/채팅을 제외한 대부분의 상태 변경은 아래 패턴을 따른다.

```
1. SET {key}:Changes "{변경종류}"          ← 마커 저장
2. HSET {key} {변경 필드들}               ← 실제 데이터 기록
3. [Redis Keyspace Notification 발생]
4. Subscriber가 알림 수신
   ├─ GET {key}:Changes  → 변경 종류 확인
   ├─ DEL {key}:Changes
   └─ 변경 종류에 따라 적절한 이벤트 broadcast
```

Keyspace 알림 설정: `KEhx` (HASH 이벤트 + 만료 이벤트)

---

## 소켓 이벤트별 Redis 흐름

---

### `handleConnection` (연결)

**파일**: `game.gateway.ts` → `game.service.ts` → `game.room.service.ts`

```
클라이언트 연결 (Socket.IO handshake + cookie에서 playerId 추출)
  │
  ├─ [createRoom 쿼리 파라미터가 있는 경우]
  │    SMEMBERS ActiveRooms               ← PIN 중복 확인
  │    HSET Room:{roomId} {host, status, title, gameMode, ...}
  │    SADD ActiveRooms roomId
  │    → Emit CREATE_ROOM {gameId}
  │
  └─ joinRoom(socket, gameId, playerId)
       HGETALL Room:{gameId}              ← 방 존재 및 상태 확인
       SMEMBERS Room:{gameId}:Players     ← 정원 초과 확인
       │
       ├─ [게임 진행 중 + 기존 플레이어 = 재접속]
       │    sendCurrentInformation()으로 현재 상태만 전달
       │
       └─ [대기 중]
            socket.join(gameId)           ← Socket.IO room join
            SET Player:{playerId}:Changes "Join"
            HSET Player:{playerId}
              {playerName:'', positionX, positionY, gameId, isAlive:'1',
               socketId, disconnected:'0'}
            ZADD Room:{gameId}:Leaderboard 0 playerId
            SADD Room:{gameId}:Players playerId
            │
            sendCurrentInformation()
              HGETALL Room:{gameId}
              SMEMBERS Room:{gameId}:Players
              HGETALL Player:{playerId}   ← 각 플레이어 정보
              → Emit JOIN_ROOM {players:[...]}
              → Emit UPDATE_ROOM_OPTION {방 옵션}
              → Emit UPDATE_ROOM_QUIZSET {퀴즈셋}
              → Emit GET_SELF_ID {playerId}
            │
            [Keyspace Notification: Player:{playerId} hset]
            PlayerSubscriber
              GET Player:{playerId}:Changes  → "Join"
              DEL Player:{playerId}:Changes
              → Emit JOIN_ROOM broadcast (방 전체)
```

---

### `handleDisconnect` (연결 해제)

**파일**: `game.gateway.ts` → `game.room.service.ts`

```
클라이언트 연결 해제
  │
  HGETALL Player:{playerId}              ← gameId 확인
  positionBroadcastService.onRoomLeft(gameId)  ← 로컬 카운트 감소
  gameChatService.onRoomLeft(gameId)           ← 로컬 카운트 감소
  HGETALL Room:{gameId}                  ← 게임 상태 확인
  │
  ├─ [게임 대기 중]
  │    [Pipeline]
  │      SREM Room:{gameId}:Players playerId
  │      ZREM Room:{gameId}:Leaderboard playerId
  │      SET Player:{playerId}:Changes "Disconnect" EX 600
  │      HSET Player:{playerId} {disconnected:'1', disconnectedAt}
  │    [EXEC]
  │    │
  │    ├─ [퇴장한 플레이어가 호스트 && 방에 남은 플레이어 있음]
  │    │    SRANDMEMBER Room:{gameId}:Players   ← 무작위 새 호스트
  │    │    SET Room:{gameId}:Changes "Host"
  │    │    HSET Room:{gameId} {host: newHostId}
  │    │
  │    └─ [방에 남은 플레이어 0명]
  │         PUBLISH room:cleanup roomId
  │         │
  │         RoomCleanupSubscriber 수신
  │           [Pipeline]
  │             SMEMBERS Room:{gameId}:Players
  │             DEL Player:{playerId}          ← 각 플레이어
  │             DEL Player:{playerId}:Changes
  │             DEL Room:{gameId}
  │             DEL Room:{gameId}:Players
  │             DEL Room:{gameId}:Leaderboard
  │             DEL Room:{gameId}:CurrentQuiz
  │             DEL Room:{gameId}:Timer
  │             SMEMBERS Room:{gameId}:QuizSet
  │             DEL Room:{gameId}:Quiz:{quizId}        ← 각 퀴즈
  │             DEL Room:{gameId}:Quiz:{quizId}:Choices
  │             DEL Room:{gameId}:QuizSet
  │             SREM ActiveRooms roomId
  │           [EXEC]
  │
  [Keyspace Notification: Player:{playerId} hset]
  PlayerSubscriber → Emit EXIT_ROOM broadcast
```

---

### `UPDATE_POSITION` (위치 업데이트)

> **배치 처리** — 아래 흐름은 즉시 실행되지 않고 50ms 배치 윈도 안에서 처리됨.

**파일**: `game.gateway.ts` → `game.service.ts` → `position-broadcast.service.ts`

```
클라이언트 → UPDATE_POSITION {gameId, positionX, positionY}
  │
  HMGET Player:{playerId} [gameId, isAlive]  ← 유효성 검증
  enqueueUpdate()  → 로컬 inputQueue[gameId]에 적재 (Redis 미사용)
  │
  ━━━ [50ms 뒤 IN 타이머 실행] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  execFlush(gameId)
  [Lua 원자 스크립트 or Pipeline]
    INCR Room:{gameId}:Seq                    ← 권위 시퀀스 번호
    HMSET Player:{playerId} {positionX, positionY}   ← 각 플레이어
    RPUSH Room:{gameId}:PositionLog {batch JSON}
    LTRIM Room:{gameId}:PositionLog -20 -1    ← 최근 20개 유지
    PUBLISH position:{gameId} {serverId, gameId, seq, updates[]}
  │
  pendingBroadcasts[gameId]에 결과 저장
  │
  ┌─ [IN + 25ms 뒤 OUT 타이머 — 동일 WAS 로컬 클라이언트] ────────
  │  broadcastRoom(gameId)
  │    → Emit UPDATE_POSITION {seq, updates} (생존자 → 생존자만)
  │    → Emit UPDATE_POSITION {seq, updates} (사망자 → 전체)
  │
  └─ [pub/sub 수신 — 다른 WAS 인스턴스의 로컬 클라이언트] ─────────
     positionSubscriber.on('pmessage', 'position:*')
       IF serverId === this.serverId → 자기 publish 무시 (OUT 타이머가 처리)
       IF !localClientCounts.has(gameId) → 해당 방 클라이언트 없음, 무시
       updates 분류 (alive / dead)
       → Emit UPDATE_POSITION {seq, aliveUpdates} to server.to(gameId)
       → broadcastToDeadPlayers(gameId, seq, deadMessages)
```

---

### `RETRANSMIT_POSITION` (위치 재전송 요청)

**파일**: `game.gateway.ts` → `position-broadcast.service.ts`

```
클라이언트 → RETRANSMIT_POSITION {gameId, lastSeq}
  │
  HMGET Player:{playerId} [gameId, isAlive]
  GET Room:{gameId}:Seq                  ← 현재 권위 시퀀스 번호
  │
  ├─ [lastSeq >= currentSeq]  → 재전송 불필요, 종료
  │
  └─ [lastSeq < currentSeq]
       LRANGE Room:{gameId}:PositionLog 0 -1   ← 전체 로그 조회
       │
       ├─ [누락 배치가 로그에 있음]
       │    해당 배치 필터링 후 전송
       │
       └─ [로그에도 없음 → Fallback 스냅샷]
            SMEMBERS Room:{gameId}:Players
            HMGET Player:{playerId} [positionX, positionY, isAlive]  ← 각 플레이어
            가시성 필터 적용 (생존자는 생존자 위치만)
       │
       → Emit POSITION_RETRANSMIT_RESPONSE {seq, updates, isFallback}
```

---

### `CHAT_MESSAGE` (채팅 메시지 전송)

> **배치 처리 + Redis Streams** — 즉시 Redis에 쓰지 않고 배치 윈도 후 XADD.

**파일**: `game.gateway.ts` → `game.chat.service.ts`

```
클라이언트 → CHAT_MESSAGE {gameId, message}
  │
  HGETALL Room:{gameId}                  ← 방 존재 확인
  HGETALL Player:{playerId}              ← 플레이어 확인
  inputQueue[gameId]에 적재              ← 아직 Redis 미사용
  │
  ━━━ [50ms 뒤 IN 타이머 실행] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  writeRoom(gameId)
    XADD Room:{gameId}:Chat MAXLEN ~ 1000
      [*] {playerId, playerName, message, timestamp, isAlive}
    lastStreamId[gameId] = 마지막 엔트리 ID 저장
  │
  ━━━ [IN + 25ms 뒤 OUT 타이머 실행] ━━━━━━━━━━━━━━━━━━━━━━━━━
  broadcastRoom(gameId)
    XRANGE Room:{gameId}:Chat (lastStreamId, +]  ← 신규 메시지만
    INCR Room:{gameId}:ChatSeq                   ← 배치 시퀀스
    batchLogMap[gameId]에 저장 (인메모리, 최대 20 배치)
    │
    ├─ Emit UPDATE_CHAT_MESSAGE {seq, messages} → 생존자 (생존자 메시지만 필터)
    └─ Emit UPDATE_CHAT_MESSAGE {messages, isDeadOnly:true} → 사망자 (사망자 메시지)

  ━━━ [60초마다 MySQL 영속화] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  SET Room:{gameId}:ChatPersistLock {instanceId} EX 70 NX  ← 분산 락
    [락 획득 성공 시]
      GET Room:{gameId}:ChatPersistCursor    ← 이전 영속화 커서
      XRANGE Room:{gameId}:Chat (cursor, +]  ← 미영속화 메시지
      MySQL INSERT
      SET Room:{gameId}:ChatPersistCursor {lastId}
      [Lua] DEL ChatPersistLock (원자적 해제)
```

---

### `RETRANSMIT_CHAT` (채팅 재전송 요청)

**파일**: `game.gateway.ts` → `game.chat.service.ts`

```
클라이언트 → RETRANSMIT_CHAT {gameId, lastSeq}
  │
  HMGET Player:{playerId} [gameId, isAlive]
  GET Room:{gameId}:ChatSeq              ← 현재 권위 시퀀스
  │
  ├─ [batchLogMap에 lastSeq 이후 데이터 있음]
  │    인메모리 캐시에서 배치 필터링
  │
  └─ [인메모리 캐시 없음 → Fallback]
       XRANGE Room:{gameId}:Chat - + COUNT 1000
       isAlive 기준 가시성 필터 적용
  │
  → Emit CHAT_RETRANSMIT_RESPONSE {seq, messages, isFallback}
```

---

### `UPDATE_ROOM_OPTION` (방 옵션 변경)

**파일**: `game.gateway.ts` → `game.room.service.ts`

```
클라이언트 → UPDATE_ROOM_OPTION {gameId, gameMode, title, maxPlayerCount}
  │
  HGETALL Room:{gameId}                  ← 방 존재 확인
  호스트 검증 (room.host === clientId)
  │
  SET Room:{gameId}:Changes "Option"
  HSET Room:{gameId} {title, gameMode, maxPlayerCount, isPublic}
  │
  [Keyspace Notification: Room:{gameId} hset]
  RoomSubscriber
    GET Room:{gameId}:Changes  → "Option"
    DEL Room:{gameId}:Changes
    HGETALL Room:{gameId}
    → Emit UPDATE_ROOM_OPTION broadcast (방 전체)
```

---

### `UPDATE_ROOM_QUIZSET` (퀴즈셋 변경)

**파일**: `game.gateway.ts` → `game.room.service.ts`

```
클라이언트 → UPDATE_ROOM_QUIZSET {gameId, quizSetId, quizCount}
  │
  HGETALL Room:{gameId}
  호스트 검증
  │
  SET Room:{gameId}:Changes "Quizset"
  HSET Room:{gameId} {quizSetId, quizCount}
  │
  [Keyspace Notification]
  RoomSubscriber
    GET Room:{gameId}:Changes  → "Quizset"
    DEL Room:{gameId}:Changes
    HGETALL Room:{gameId}
    → Emit UPDATE_ROOM_QUIZSET broadcast (방 전체)
```

---

### `START_GAME` (게임 시작)

**파일**: `game.gateway.ts` → `game.service.ts`

```
클라이언트 → START_GAME {gameId}
  │
  HGETALL Room:{gameId}                  ← 방 존재 및 상태 확인
  호스트 검증
  │
  [퀴즈 데이터 로드 (DB 또는 인메모리 캐시)]
  │
  [이전 퀴즈 데이터 삭제]
    SMEMBERS Room:{gameId}:QuizSet       ← 이전 퀴즈 ID 목록
    DEL Room:{gameId}:Quiz:{quizId}      ← 각 퀴즈
    DEL Room:{gameId}:Quiz:{quizId}:Choices
    DEL Room:{gameId}:QuizSet
  │
  [새 퀴즈 데이터 저장 (무작위 선택 후 slicing)]
    SADD Room:{gameId}:QuizSet ...quizIds
    HSET Room:{gameId}:Quiz:{quizId} {question, answer, limitTime, choiceCount}
    HSET Room:{gameId}:Quiz:{quizId}:Choices {order: content}    ← 각 퀴즈
  │
  [리더보드 초기화]
    ZRANGE Room:{gameId}:Leaderboard 0 -1  ← 기존 플레이어 목록
    ZADD Room:{gameId}:Leaderboard 0 playerId   ← 각 플레이어 점수 0으로 리셋
  │
  SET Room:{gameId}:Changes "Start"
  HSET Room:{gameId} {status:'playing'}
  SET Room:{gameId}:CurrentQuiz "-1:end"  ← 퀴즈 상태머신 초기화
  SET Room:{gameId}:Timer "timer" EX 3   ← 3초 후 첫 퀴즈 시작
  │
  [Keyspace Notification: Room:{gameId} hset]
  RoomSubscriber → Emit START_GAME broadcast (방 전체)
  │
  ━━━ [3초 후 Timer 만료] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  TimerSubscriber 감지 (expired 이벤트)
    GET Room:{gameId}:CurrentQuiz  → "-1:end"
    → handleNextQuiz() 호출 (첫 번째 퀴즈 시작)
```

---

### `SET_PLAYER_NAME` (플레이어 이름 설정)

**파일**: `game.gateway.ts` → `game.service.ts`

```
클라이언트 → SET_PLAYER_NAME {playerName}
  │
  SET Player:{playerId}:Changes "Name"
  HMSET Player:{playerId} {playerName}
  │
  [Keyspace Notification: Player:{playerId} hset]
  PlayerSubscriber
    GET Player:{playerId}:Changes  → "Name"
    DEL Player:{playerId}:Changes
    HGETALL Player:{playerId}
    → Emit SET_PLAYER_NAME broadcast (방 전체)
```

---

### `KICK_ROOM` (플레이어 강퇴)

**파일**: `game.gateway.ts` → `game.room.service.ts`

```
클라이언트 → KICK_ROOM {gameId, kickPlayerId}
  │
  HGETALL Room:{gameId}
  호스트 검증
  HGETALL Player:{kickPlayerId}          ← 대상 플레이어 존재 확인
  │
  SET Player:{kickPlayerId}:Changes "Kicked" EX 6000
  HSET Player:{kickPlayerId} {isAlive:'0'}
  │
  [Keyspace Notification]
  PlayerSubscriber
    GET Player:{kickPlayerId}:Changes  → "Kicked"
    → Emit KICK_ROOM broadcast (방 전체)
    → handlePlayerKicked() → Emit EXIT_ROOM (강퇴된 플레이어)
```

---

## 퀴즈 상태머신 (타이머 기반 자동 흐름)

게임 시작 이후의 퀴즈 진행은 **소켓 이벤트 없이** Redis 타이머 만료로 자동 구동된다.

### 퀴즈 진행 시퀀스

```
SET Room:{gameId}:Timer "timer" EX {초}
  │
  ━━━ [TTL 만료] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  TimerSubscriber: __keyspace@0__:Room:*:Timer "expired"
  GET Room:{gameId}:CurrentQuiz
  │
  ├─ ["{num}:end" 상태 → 다음 퀴즈 시작]
  │    handleNextQuiz()
  │      SMEMBERS Room:{gameId}:QuizSet
  │      │
  │      ├─ [남은 퀴즈 있음 && Survival 모드에서 생존자 2명 이상]
  │      │    HGETALL Room:{gameId}:Quiz:{nextQuizId}
  │      │    HGETALL Room:{gameId}:Quiz:{nextQuizId}:Choices
  │      │    → Emit START_QUIZ_TIME {quiz, choices} (방 전체)
  │      │    SET Room:{gameId}:CurrentQuiz "{newNum}:start"
  │      │    SET Room:{gameId}:Timer "timer" EX {limitTime + 3}
  │      │
  │      └─ [퀴즈 종료 조건 충족]  → 게임 종료 흐름 (아래 참조)
  │
  └─ ["{num}:start" 상태 → 채점]
       handleQuizScoring()
         SET Room:{gameId}:ScoringStatus "START" NX    ← 중복 채점 방지 락
         │
         SMEMBERS Room:{gameId}:Players
         HGETALL Player:{playerId}                      ← 각 플레이어
         positionX/Y → 정답 영역 판정
         │
         SET Player:{playerId}:Changes "AnswerCorrect"  ← 각 플레이어
         HSET Player:{playerId} {isAnswerCorrect:'1'|'0'}
         │
         [점수 계산]
           ├─ RANKING 모드: ZINCRBY Room:{gameId}:Leaderboard (1000/정답자수) playerId
           └─ SURVIVAL 모드: 오답자 HSET Player:{playerId} {isAlive:'0'}
         │
         PUBLISH scoring:{gameId} {clientCount}
         DEL Room:{gameId}:ScoringStatus               ← 락 해제
         │
         ScoringSubscriber 수신
           INCRBY Room:{gameId}:ScoringCount {clientCount}
           SCARD Room:{gameId}:Players
           │
           [모든 WAS 채점 완료 시]
             HGETALL Room:{gameId}:Quiz:{currentQuizId}
             ZRANGE Room:{gameId}:Leaderboard 0 -1 WITHSCORES
             HGET Player:{playerId} isAnswerCorrect      ← 각 플레이어
             → Emit END_QUIZ_TIME {answer, players} (방 전체)
             SET Room:{gameId}:CurrentQuiz "{num}:end"
             SET Room:{gameId}:Timer "timer" EX 10 NX    ← 10초 결과 대기
             SET Room:{gameId}:ScoringCount 0
```

### 게임 종료 흐름

```
handleNextQuiz() → 종료 조건 (퀴즈 소진 or Survival 생존자 ≤1)
  │
  SMEMBERS Room:{gameId}:Players
  HSET Player:{playerId} {isAlive:'1'}   ← 전원 부활 (다음 게임 대비)
  ZRANGE Room:{gameId}:Leaderboard 0 -1 WITHSCORES
  최고 점수자를 새 호스트로 지정
  │
  SET Room:{gameId}:Changes "End"
  HSET Room:{gameId} {status:'waiting', isWaiting:'1', host: newHost}
  → Emit END_GAME {hostId} (방 전체)
```

---

## 구독자별 담당 요약

| Subscriber | 감지 대상 | 담당 역할 |
|---|---|---|
| `RoomSubscriber` | `Room:{gameId}` HSET 알림 | 방 옵션/상태 변경 broadcast |
| `PlayerSubscriber` | `Player:{playerId}` HSET 알림 | 플레이어 입퇴장·이름·강퇴 broadcast |
| `TimerSubscriber` | `Room:{gameId}:Timer` 만료 알림 | 퀴즈 진행/채점 상태머신 구동 |
| `ScoringSubscriber` | `scoring:{gameId}` pub/sub | 분산 채점 집계 및 결과 broadcast |
| `RoomCleanupSubscriber` | `room:cleanup` pub/sub | Redis 전체 방 데이터 삭제 |
