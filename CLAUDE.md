# QuizGround - CLAUDE.md

## Project Overview
Real-time multiplayer quiz platform (up to 200 players/room). Two game modes: Survival (elimination) / Ranking (points). Monorepo: BE (NestJS) + FE (React+Vite).

---

## Stack

### BE (`/BE`)
- NestJS v10, TypeScript, Node.js
- Socket.IO (WebSocket, `/game` namespace)
- MySQL 8.0 + TypeORM (entities auto-sync in DEV mode)
- Redis (ioredis) — game state, pub/sub, batch processing
- JWT + Passport.js auth
- Prometheus (prom-client) + Pinpoint APM

### FE (`/FE`)
- React 18, TypeScript, Vite
- Zustand (state), TanStack Query (server state)
- Socket.IO client, Axios
- Tailwind CSS + Emotion + Material-UI
- Framer Motion + Lottie (animations)
- MSW (API mocking for dev)

---

## Commands

### BE
```bash
cd BE
npm run start:dev          # dev with hot reload
npm run build              # compile to dist/
npm run test               # unit tests
npm run test:integration   # integration tests (real socket + redis-mock)
npm run test:e2e           # e2e tests
npm run lint               # eslint --fix
npm run format             # prettier
```

### FE
```bash
cd FE
npm run dev                # vite dev server (port 5173)
npm run build              # production build
npm run build-dev          # dev build
npm run lint               # eslint
```

---

## Environment Variables (BE)

| Var | Default | Notes |
|-----|---------|-------|
| DB_HOST | localhost | MySQL |
| DB_PORT | 3306 | |
| DB_USER | root | |
| DB_PASSWD | test | |
| DB_NAME | test_db | |
| REDIS_URL | redis://localhost:6379 | |
| WAS_PORT | 3000 | |
| DEV | - | enables TypeORM synchronize |

---

## Infrastructure (Google Cloud)

```
Internet
  │
  ▼
nginx VM (e2-micro, 1 vCPU / 1 GB RAM)  ← FE static + BE reverse proxy, external IP
  │  cookie sticky session (upstream)
  ├──▶ node-1 VM (e2-small, 1 vCPU / 1 GB RAM)  ← NestJS WAS, internal IP only
  └──▶ node-2 VM (e2-small, 1 vCPU / 1 GB RAM)  ← NestJS WAS, internal IP only
            │
     quizground VPC (10.10.0.0/16)
            ├──▶ redis VM  (e2-micro, 1 vCPU / 1 GB RAM)  :6379
            └──▶ mysql VM  (e2-small, 1 vCPU / 1 GB RAM)  :3306
```

- All VMs in the `quizground` VPC; only nginx has an external IP (acts as CI/CD bastion)
- Cloud NAT for outbound internet on internal VMs
- Rolling deploy: node-1 → node-2 via PM2 reload (zero-downtime)
- Sticky session via cookie hash so each player lands on the same WAS; Redis pub/sub handles cross-WAS state sync

---

## Architecture

### Distributed WAS
WAS runs as multiple distributed instances. All game state (rooms, player sessions, scores) is stored in Redis so any server can serve any request — Redis is the source of truth for session consistency. Position updates are batch-written to Redis and published to `position:{gameId}` pub/sub so every WAS instance with local clients in that room broadcasts to its own sockets. Self-published messages are filtered by `serverId` to prevent double-broadcast.

### Game Flow
```
Client connects → GameGateway (cookie-based playerId)
  → createRoom / joinRoom → Redis Room:{gameId} hash
  → startGame → pub/sub subscribers activate
  → quiz loop: startQuizTime → position updates (BatchProcessor) → endQuizTime → scoring
  → gameEnd → DB archive + Redis cleanup
```

### Redis Key Patterns
```
Room:{gameId}                    # room metadata hash
Room:{gameId}:Players            # set of playerIds
Room:{gameId}:Quiz:{quizId}      # quiz data
Room:{gameId}:Leaderboard        # sorted scores
Room:{gameId}:CurrentQuiz        # current quiz index
Room:{gameId}:Timer              # timer state
Player:{playerId}                # player session hash
Player:{playerId}:Changes        # dirty flags for batch
Quizset:{quizSetId}              # cached quiz set
ActiveRooms                      # set of active game IDs
```

### Event Subscribers (game.module.ts)
- `ScoringSubscriber` — quiz answer scoring
- `TimerSubscriber` — quiz timer management
- `RoomSubscriber` — room state broadcast
- `PlayerSubscriber` — player state updates
- `RoomCleanupSubscriber` — 30-min TTL cleanup

### Key BE Services
| Service | File | Purpose |
|---------|------|---------|
| GameGateway | `game/game.gateway.ts` | WebSocket entry, event handlers |
| GameService | `game/service/game.service.ts` | Core logic, position updates |
| GameRoomService | `game/service/game.room.service.ts` | Room lifecycle |
| BatchProcessor | `game/service/position-broadcast.service.ts` | Batches socket events (~100ms, POSITION_BATCH_TIME=50ms IN/OUT 엇갈림) |
| GameChatService | `game/service/game.chat.service.ts` | Redis pub/sub chat |
| QuizCacheService | - | In-memory quiz cache |
| MetricService | `metric/metric.service.ts` | Prometheus metrics |

### FE Zustand Stores (`/FE/src/features/game/data/store/`)
- `usePlayerStore` — positions, names, alive status
- `useRoomStore` — room metadata
- `useQuizStore` — current quiz, choices, timer
- `useChatStore` — chat messages

---

## DB Schema
- `quiz_set` — title (FTS ngram for Korean), category, user_id
- `quiz` — question, explanation, quizSetId
- `quiz_choice` — text, isCorrect, quizId
- `user` — email, password(bcrypt), nickname, points
- `user_quiz_archive` — userId, quizSetId, mode, score

---

## Key Files
```
BE/src/main.ts                          # bootstrap
BE/src/app.module.ts                    # DB/Redis config, env vars
BE/src/game/game.gateway.ts             # WebSocket events
BE/src/game/game.module.ts              # wires everything
BE/src/common/constants/redis-key.constant.ts  # Redis key templates
BE/test/integration/setup/game.setup.ts        # test infra

FE/src/api/socket/socket.ts             # Socket.IO client (mock support via PIN)
FE/src/api/socket/socketEventTypes.ts  # event type defs
FE/src/features/game/data/socketListener.ts    # socket handlers
FE/src/constants/socketEvents.ts       # event name constants
```

---

## Notable Patterns
- **BatchProcessor**: aggregates position updates, fires every ~100ms (POSITION_BATCH_TIME=50ms, IN/OUT 페이즈 엇갈림) → p95 latency 7.1s→0.11s
- **Mock Socket (FE)**: PIN-based switching in `socket.ts` for offline dev
- **FTS**: MySQL ngram parser on `quiz_set.title` for Korean search (50% faster than LIKE)
- **Cookie auth**: playerId stored in secure httpOnly cookie (sameSite=none)
- **CORS whitelist**: quizground.site, quizground.duckdns.org
- **Socket Admin**: `/admin` endpoint for dev monitoring
- **Production socket**: `https://quizground.site:3333/game`

---

## Testing
- Unit: `src/**/*.spec.ts`
- Integration: `test/integration/` — real socket connections, ioredis-mock
- E2E: `test/jest-e2e.json`
- Key integration files:
  - `test/integration/game/game.integration.spec.ts`
  - `test/integration/game/game-survival.integration.spec.ts`
  - `test/integration/setup/socket.helper.ts`
