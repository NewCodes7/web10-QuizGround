import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { Namespace, Socket } from 'socket.io';
import * as promClient from 'prom-client';
import { v4 as uuidv4 } from 'uuid';
import { REDIS_KEY } from '../../common/constants/redis-key.constant';
import { SurvivalStatus } from '../../common/constants/game';
import SocketEvents from '../../common/constants/socket-events';
import { GameWsException } from '../../common/exceptions/game.ws.exception';
import { ExceptionMessage } from '../../common/constants/exception-message';
import { RetransmitPositionDto } from '../dto/retransmit-position.dto';
import {
  POSITION_BATCH_TIME,
  POSITION_MAX_TIMERS,
  POSITION_HISTORY_SIZE
} from '../../common/constants/batch-time';

interface PositionMessage {
  playerId: string;
  positionX: number;
  positionY: number;
  gameId: string;
  isAlive: string;
}

interface PositionUpdate {
  playerId: string;
  playerPosition: [number, number];
}

interface TimerSlot {
  offsetTimeout: NodeJS.Timeout | null;
  interval: NodeJS.Timeout | null;
  rooms: Set<string>;
}

/**
 * Lua script: atomically (TICKET-005)
 *   1. INCR Room:{gameId}:Seq → new seq
 *   2. HMSET positionX/positionY for every player in the batch
 *   3. RPUSH + LTRIM Room:{gameId}:PositionLog  (TICKET-006)
 *   4. PUBLISH position:{gameId} batch payload   (for future multi-server support)
 *
 * KEYS:
 *   [1] seqKey       = Room:{gameId}:Seq
 *   [2] channelKey   = position:{gameId}
 *   [3] logKey       = Room:{gameId}:PositionLog
 *   [4..3+N]         = Player:{playerId} for each of N players
 *
 * ARGV:
 *   [1]           serverId
 *   [2]           gameId
 *   [3]           historySize  (e.g. "20")
 *   [4..3+N]      positionX values (as string)
 *   [4+N..3+2N]   positionY values (as string)
 *   [4+2N..3+3N]  isAlive values   ("0" | "1")
 *   [4+3N..3+4N]  playerId values
 *
 * Returns: new seq (integer)
 */
const LUA_POSITION_FLUSH = `
local n = #KEYS - 3
local serverId = ARGV[1]
local gameId   = ARGV[2]
local histSize = tonumber(ARGV[3])

local seq = redis.call('INCR', KEYS[1])

local pubParts = {}
local logParts = {}

for i = 1, n do
  local playerKey = KEYS[3 + i]
  local posX      = ARGV[3 + i]
  local posY      = ARGV[3 + n + i]
  local isAlive   = ARGV[3 + 2 * n + i]
  local playerId  = ARGV[3 + 3 * n + i]

  redis.call('HMSET', playerKey, 'positionX', posX, 'positionY', posY)

  pubParts[#pubParts + 1] = '{"playerId":"' .. playerId
    .. '","playerPosition":[' .. posX .. ',' .. posY
    .. '],"isAlive":"' .. isAlive .. '"}'

  logParts[#logParts + 1] = '{"playerId":"' .. playerId
    .. '","positionX":' .. posX
    .. ',"positionY":' .. posY
    .. ',"isAlive":"' .. isAlive .. '"}'
end

local pubPayload = '{"serverId":"' .. serverId
  .. '","gameId":"' .. gameId
  .. '","seq":' .. seq
  .. ',"updates":[' .. table.concat(pubParts, ',') .. ']}'
redis.call('PUBLISH', KEYS[2], pubPayload)

local logEntry = '{"seq":' .. seq
  .. ',"updates":[' .. table.concat(logParts, ',') .. ']}'
redis.call('RPUSH', KEYS[3], logEntry)
redis.call('LTRIM', KEYS[3], -histSize, -1)

return seq
`;

@Injectable()
export class PositionBroadcastService implements OnApplicationShutdown, OnModuleInit {
  private readonly logger = new Logger(PositionBroadcastService.name);

  /** Per-instance server ID — used to filter self-published messages from pub/sub. */
  private readonly serverId = uuidv4();

  /** Dedicated Redis connection for subscribing to position:* pub/sub channel. */
  private positionSubscriber: Redis;

  private server: Namespace;

  /** Number of clients from this server currently in each room. */
  private localClientCounts = new Map<string, number>();

  /** gameId → playerId → socketId. 로컬 클라이언트의 소켓 ID 역매핑. */
  private playerSocketMap = new Map<string, Map<string, string>>();

  /** gameId → Set<playerId>. 탈락한 플레이어 집합 (서바이벌 모드). */
  private deadPlayerIds = new Map<string, Set<string>>();

  /** playerId → gameId. updatePosition 핫패스에서 Redis 조회 없이 검증하기 위한 역매핑. */
  private playerGameMap = new Map<string, string>();

  /** playerId → playerName. chatMessage에서 Redis 조회 없이 이름 조회하기 위한 캐시. */
  private playerNameMap = new Map<string, string>();

  /** gameId → 타이머 슬롯 인덱스. cleanupRoom 에서 O(1) 삭제용. */
  private roomSlotMap = new Map<string, number>();

  /**
   * IN 타이머: inputQueue → Redis 쓰기 (execFlush)
   * OUT 타이머: pendingBroadcasts → socket.io emit
   * OUT은 IN보다 POSITION_BATCH_TIME/2 늦게 시작해 IN 쓰기 후 OUT이 읽도록 순서를 보장한다.
   */
  private inTimers: TimerSlot[] = [];
  private outTimers: TimerSlot[] = [];
  private roomCounter = 0;

  /**
   * Local input queue (TICKET-003).
   * gameId → (playerId → latest PositionMessage)
   * Overwrite strategy: the most recent updatePosition call wins per player per batch.
   * Filled by enqueueUpdate(); drained every POSITION_BATCH_TIME ms by the IN timer.
   */
  private inputQueue = new Map<string, Map<string, PositionMessage>>();

  /**
   * IN→OUT 인메모리 버퍼.
   * IN(writeRoom)이 execFlush 결과를 여기에 넣고,
   * OUT(broadcastRoom)이 꺼내서 socket.io에 emit한다.
   */
  private pendingBroadcasts = new Map<
    string,
    Array<{ seq: number; aliveUpdates: PositionUpdate[]; deadMessages: PositionMessage[] }>
  >();

  /** SHA1 of the loaded Lua script for EVALSHA. */
  private luaSha: string;
  /** Falls back to non-atomic pipeline when Redis/mock does not support Lua. */
  private luaAvailable = true;

  // ── Prometheus metrics (TICKET-010) ────────────────────────────────────────
  private readonly flushUpdatesCounter: promClient.Counter;
  private readonly retransmitCounter: promClient.Counter;
  private readonly retransmitFallbackCounter: promClient.Counter;
  private readonly inputQueueSizeGauge: promClient.Gauge;
  private readonly flushDurationHistogram: promClient.Histogram;

  constructor(@InjectRedis() private readonly redis: Redis) {
    for (let i = 0; i < POSITION_MAX_TIMERS; i++) {
      this.inTimers.push({ offsetTimeout: null, interval: null, rooms: new Set() });
      this.outTimers.push({ offsetTimeout: null, interval: null, rooms: new Set() });
    }

    this.flushUpdatesCounter = new promClient.Counter({
      name: 'position_flush_updates_total',
      help: 'Total position updates flushed in each batch cycle',
      labelNames: ['gameId']
    });
    this.retransmitCounter = new promClient.Counter({
      name: 'position_retransmit_requests_total',
      help: 'Total retransmit requests received'
    });
    this.retransmitFallbackCounter = new promClient.Counter({
      name: 'position_retransmit_fallback_total',
      help: 'Total retransmit requests that fell back to full-snapshot mode'
    });
    this.inputQueueSizeGauge = new promClient.Gauge({
      name: 'position_input_queue_size',
      help: 'Current number of pending position updates per room',
      labelNames: ['gameId']
    });
    this.flushDurationHistogram = new promClient.Histogram({
      name: 'position_flush_duration_ms',
      help: 'Time taken to flush one room in milliseconds',
      labelNames: ['gameId'],
      buckets: [5, 10, 20, 50, 100, 500, 1000, 2500, 5000, 10000, 20000, 30000]
    });
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async onModuleInit(): Promise<void> {
    try {
      this.luaSha = (await this.redis.script('LOAD', LUA_POSITION_FLUSH)) as string;
      this.logger.verbose(`Lua flush script loaded (SHA: ${this.luaSha})`);
    } catch {
      // ioredis-mock and some Redis proxies do not support EVAL/EVALSHA.
      // Fall back to non-atomic pipeline path so tests and restricted envs still work.
      this.luaAvailable = false;
      this.logger.warn('Lua script load failed — using non-atomic pipeline fallback');
    }

    // Subscribe to position:* pub/sub channel to receive position batches from other WAS instances.
    // Self-published messages are filtered by serverId so they are not double-broadcast.
    this.positionSubscriber = this.redis.duplicate();
    await this.positionSubscriber.psubscribe('position:*');
    this.positionSubscriber.on('pmessage', (_pattern, channel, message) => {
      try {
        this.handlePositionMessage(channel, message);
      } catch (err) {
        this.logger.error(`[positionSub] handler error: ${(err as Error).message}`);
      }
    });
    this.logger.verbose(`Position pub/sub subscriber started (serverId: ${this.serverId})`);
  }

  /**
   * Called from GameGateway.afterInit.
   * Sets the Socket.IO namespace and starts all slot timers with staggered offsets.
   */
  initTimers(server: Namespace): void {
    this.server = server;
    const slotOffset = POSITION_BATCH_TIME / POSITION_MAX_TIMERS;
    const outDelay = POSITION_BATCH_TIME / 2;
    for (let i = 0; i < POSITION_MAX_TIMERS; i++) {
      const idx = i;
      // IN timer: drain inputQueue → Redis write (execFlush) → push to pendingBroadcasts
      this.inTimers[idx].offsetTimeout = setTimeout(() => {
        this.inTimers[idx].interval = setInterval(() => this.writeSlot(idx), POSITION_BATCH_TIME);
      }, idx * slotOffset);
      // OUT timer: drain pendingBroadcasts → socket.io emit (half-period after IN)
      this.outTimers[idx].offsetTimeout = setTimeout(() => {
        this.outTimers[idx].interval = setInterval(
          () => this.broadcastSlot(idx),
          POSITION_BATCH_TIME
        );
      }, idx * slotOffset + outDelay);
    }
    this.logger.verbose(
      `Position timer slots started: ${POSITION_MAX_TIMERS} IN+OUT slots × ${POSITION_BATCH_TIME}ms, ${slotOffset}ms offset, ${outDelay}ms IN→OUT gap`
    );
  }

  onApplicationShutdown(): void {
    for (const slot of this.inTimers) {
      if (slot.offsetTimeout) clearTimeout(slot.offsetTimeout);
      if (slot.interval) clearInterval(slot.interval);
    }
    for (const slot of this.outTimers) {
      if (slot.offsetTimeout) clearTimeout(slot.offsetTimeout);
      if (slot.interval) clearInterval(slot.interval);
    }
    if (this.positionSubscriber) {
      this.positionSubscriber.disconnect();
    }
    this.logger.verbose('PositionBroadcastService shutdown complete');
  }

  // ── Room lifecycle ─────────────────────────────────────────────────────────

  /**
   * Called by GameRoomService when a client from this server joins a room.
   * On first client: initialises the input queue and assigns a timer slot (TICKET-007).
   */
  onRoomJoined(gameId: string): void {
    const count = (this.localClientCounts.get(gameId) ?? 0) + 1;
    this.localClientCounts.set(gameId, count);

    if (count === 1) {
      this.initRoom(gameId);
      this.logger.verbose(`Position input queue started for room ${gameId}`);
    }
  }

  /**
   * 플레이어가 이 WAS에 접속했을 때 호출. 재접속 시 socketId를 덮어쓴다.
   * GameRoomService.joinRoom 에서 socketId 가 Redis에 기록된 직후 호출한다.
   */
  onPlayerJoined(gameId: string, playerId: string, socketId: string, playerName?: string): void {
    let playerMap = this.playerSocketMap.get(gameId);
    if (!playerMap) {
      playerMap = new Map();
      this.playerSocketMap.set(gameId, playerMap);
    }
    playerMap.set(playerId, socketId);
    this.playerGameMap.set(playerId, gameId);
    if (playerName !== undefined) {
      this.playerNameMap.set(playerId, playerName);
    }
  }

  /**
   * 플레이어가 방을 나갔을 때 호출.
   * GameRoomService.handlePlayerExit 에서 호출한다.
   */
  onPlayerLeft(gameId: string, playerId: string): void {
    this.playerSocketMap.get(gameId)?.delete(playerId);
    this.deadPlayerIds.get(gameId)?.delete(playerId);
    this.playerGameMap.delete(playerId);
    this.playerNameMap.delete(playerId);
  }

  /**
   * 플레이어가 탈락했을 때 호출 (서바이벌 오답 / 강퇴).
   * QuizStateMachineSubscriber 및 GameRoomService.kickRoom 에서 호출한다.
   */
  onPlayerDied(gameId: string, playerId: string): void {
    let deadSet = this.deadPlayerIds.get(gameId);
    if (!deadSet) {
      deadSet = new Set();
      this.deadPlayerIds.set(gameId, deadSet);
    }
    deadSet.add(playerId);
  }

  /**
   * Called by GameRoomService when a client from this server leaves a room.
   * On last client: removes the input queue and all associated state (TICKET-007).
   */
  onRoomLeft(gameId: string): void {
    const current = this.localClientCounts.get(gameId) ?? 0;
    if (current <= 1) {
      this.localClientCounts.delete(gameId);
      this.cleanupRoom(gameId);
    } else {
      this.localClientCounts.set(gameId, current - 1);
    }
  }

  // ── Input (TICKET-003) ─────────────────────────────────────────────────────

  /**
   * Enqueues a position update for the next batch flush.
   * Called from GameService.updatePosition instead of writing to Redis immediately.
   * Overwrite strategy: the latest call per player within a batch interval wins.
   */
  enqueueUpdate(gameId: string, message: PositionMessage): void {
    const queue = this.inputQueue.get(gameId);
    if (!queue) return; // room not active on this server
    queue.set(message.playerId, message);
  }

  /** chatMessage 핫패스용. 캐시 미스 시 undefined 반환 → 호출자가 Redis lazy fetch. */
  getPlayerName(playerId: string): string | undefined {
    return this.playerNameMap.get(playerId);
  }

  /** setPlayerName 이벤트 수신 시 캐시 갱신. */
  updatePlayerName(playerId: string, name: string): void {
    if (this.playerNameMap.has(playerId)) {
      this.playerNameMap.set(playerId, name);
    }
  }

  /** 퀴즈 전환 시 생존자 수 판별용. Redis 조회 없이 인메모리에서 반환한다. */
  getDeadPlayerCount(gameId: string): number {
    return this.deadPlayerIds.get(gameId)?.size ?? 0;
  }

  /**
   * updatePosition 핫패스용 인메모리 조회.
   * Redis hmget 대신 이 메서드를 사용해 네트워크 왕복을 제거한다.
   */
  getPlayerState(playerId: string): { gameId: string; isAlive: string } | null {
    const gameId = this.playerGameMap.get(playerId);
    if (!gameId) return null;
    const isAlive = this.deadPlayerIds.get(gameId)?.has(playerId) ? '0' : '1';
    return { gameId, isAlive };
  }

  // ── Retransmit (TICKET-001, 002, 006) ─────────────────────────────────────

  /**
   * Handles a position retransmit request.
   *
   * Authorization (TICKET-001):
   *   - Validates that the requesting player is in the stated room.
   *   - Validates lastSeq ≥ 0 (enforced also by DTO @Min(0)).
   *
   * Visibility policy (TICKET-002):
   *   - Alive requester → only alive player positions.
   *   - Dead  requester → all positions (alive + dead), matching broadcast policy.
   *
   * Retransmit strategy (TICKET-006):
   *   - If [lastSeq+1 .. currentSeq] is within the Redis position log → replay those batches.
   *   - Otherwise (log too old) → fall back to current Redis snapshot.
   *   - `isFallback: true` in the response indicates the snapshot path was taken.
   */
  async handleRetransmit(dto: RetransmitPositionDto, playerId: string, socket: Socket): Promise<void> {
    const { gameId, lastSeq } = dto;

    // TICKET-001, 004, 006: 세 Redis 호출은 서로 독립적이므로 병렬로 실행한다.
    const [[playerGameId, requesterIsAlive], currentSeqStr, rawEntries] = await Promise.all([
      this.redis.hmget(REDIS_KEY.PLAYER(playerId), 'gameId', 'isAlive'),
      this.redis.get(REDIS_KEY.ROOM_SEQ(gameId)),
      this.redis.lrange(REDIS_KEY.ROOM_POSITION_LOG(gameId), 0, -1)
    ]);

    if (!playerGameId) {
      throw new GameWsException(SocketEvents.RETRANSMIT_POSITION, ExceptionMessage.NOT_A_PLAYER);
    }
    if (playerGameId !== gameId) {
      throw new GameWsException(
        SocketEvents.RETRANSMIT_POSITION,
        ExceptionMessage.UNAUTHORIZED_ROOM_ACCESS
      );
    }

    this.retransmitCounter.inc();

    this.logger.debug(
      `[handleRetransmit] recv — playerId=${playerId} gameId=${gameId} lastSeq=${lastSeq}`
    );

    const currentSeq = parseInt(currentSeqStr ?? '0');

    if (lastSeq >= currentSeq) {
      return; // nothing to retransmit
    }
    type LogUpdate = { playerId: string; positionX: number; positionY: number; isAlive: string };
    type LogEntry = { seq: number; updates: LogUpdate[] };
    const logEntries: LogEntry[] = rawEntries.map((e) => JSON.parse(e));

    const oldestSeq = logEntries[0]?.seq ?? currentSeq;
    const missingEntries = logEntries.filter((e) => e.seq > lastSeq);

    let isFallback = false;
    const playerPositions = new Map<
      string,
      { positionX: number; positionY: number; isAlive: string }
    >();

    if (missingEntries.length === 0 || lastSeq < oldestSeq - 1) {
      // Fallback: full snapshot from Redis
      isFallback = true;
      this.retransmitFallbackCounter.inc();
      this.logger.warn(
        `Retransmit fallback — room=${gameId} lastSeq=${lastSeq} oldestLogSeq=${oldestSeq} currentSeq=${currentSeq}`
      );

      const playerIds = await this.redis.smembers(REDIS_KEY.ROOM_PLAYERS(gameId));
      if (playerIds.length === 0) return;

      const pipeline = this.redis.pipeline();
      playerIds.forEach((id) =>
        pipeline.hmget(REDIS_KEY.PLAYER(id), 'positionX', 'positionY', 'isAlive')
      );
      type PosResult = [Error | null, [string, string, string] | null];
      const results = (await pipeline.exec()) as PosResult[];
      results.forEach(([err, data], index) => {
        if (err || !data) return;
        playerPositions.set(playerIds[index], {
          positionX: parseFloat(data[0] ?? '0'),
          positionY: parseFloat(data[1] ?? '0'),
          isAlive: data[2] ?? SurvivalStatus.ALIVE
        });
      });
    } else {
      // Replay log entries: latest position per player across missing batches
      for (const entry of missingEntries) {
        for (const u of entry.updates) {
          playerPositions.set(u.playerId, {
            positionX: u.positionX,
            positionY: u.positionY,
            isAlive: u.isAlive
          });
        }
      }
    }

    // TICKET-002: visibility filtering
    const isAliveRequester = (requesterIsAlive ?? SurvivalStatus.ALIVE) === SurvivalStatus.ALIVE;

    const updates = Array.from(playerPositions.entries())
      .filter(([, data]) => !isAliveRequester || data.isAlive === SurvivalStatus.ALIVE)
      .map(([pid, data]) => ({
        playerId: pid,
        playerPosition: [data.positionX, data.positionY] as [number, number],
        appliedSeq: currentSeq
      }));

    this.logger.debug(
      `[handleRetransmit] send — playerId=${playerId} gameId=${gameId} ` +
        `lastSeq=${lastSeq} currentSeq=${currentSeq} ` +
        `isFallback=${isFallback} updateCount=${updates.length} ` +
        `isAliveRequester=${isAliveRequester}`
    );

    socket.emit(SocketEvents.POSITION_RETRANSMIT_RESPONSE, {
      seq: currentSeq,
      retransmitted: true,
      isFallback,
      updates
    });
  }

  // ── Private: room init / cleanup ───────────────────────────────────────────

  private initRoom(gameId: string): void {
    this.inputQueue.set(gameId, new Map());
    this.assignTimer(gameId);
  }

  /**
   * Removes all local state for a room.
   * Also deletes Redis seq and log keys so stale data does not persist (TICKET-007).
   */
  private cleanupRoom(gameId: string): void {
    const idx = this.roomSlotMap.get(gameId);
    if (idx !== undefined) {
      this.inTimers[idx].rooms.delete(gameId);
      this.outTimers[idx].rooms.delete(gameId);
      this.roomSlotMap.delete(gameId);
    }
    this.inputQueue.delete(gameId);
    this.pendingBroadcasts.delete(gameId);
    this.playerSocketMap.delete(gameId);
    this.deadPlayerIds.delete(gameId);
    this.inputQueueSizeGauge.labels(gameId).set(0);

    this.redis
      .del(REDIS_KEY.ROOM_SEQ(gameId), REDIS_KEY.ROOM_POSITION_LOG(gameId))
      .catch((err) =>
        this.logger.error(`Redis cleanup failed for room ${gameId}: ${(err as Error).message}`)
      );

    this.logger.verbose(`Position input queue cleaned up for room ${gameId}`);
  }

  /** Round-robin slot assignment; warns when a slot hosts more than one room. */
  private assignTimer(gameId: string): void {
    const idx = this.roomCounter % POSITION_MAX_TIMERS;
    this.inTimers[idx].rooms.add(gameId);
    this.outTimers[idx].rooms.add(gameId);
    this.roomSlotMap.set(gameId, idx);
    this.roomCounter++;

    const slotSize = this.inTimers[idx].rooms.size;
    if (slotSize > 1) {
      this.logger.warn(
        `Slot ${idx} now has ${slotSize} rooms — flush latency per room in this slot may increase`
      );
    }
  }

  // ── Private: IN timer (write) ──────────────────────────────────────────────

  private writeSlot(slotIndex: number): void {
    for (const gameId of this.inTimers[slotIndex].rooms) {
      this.writeRoom(gameId).catch((err) => {
        this.logger.error(`writeRoom error for room ${gameId}: ${(err as Error).message}`);
      });
    }
  }

  /**
   * IN phase: drain inputQueue → execFlush → store result in pendingBroadcasts.
   * The OUT timer picks up pendingBroadcasts ~POSITION_BATCH_TIME/2 ms later.
   */
  private async writeRoom(gameId: string): Promise<void> {
    const localQueue = this.inputQueue.get(gameId);
    if (!localQueue || localQueue.size === 0) return;

    const writeStart = Date.now();
    const batch = Array.from(localQueue.values());
    this.inputQueueSizeGauge.labels(gameId).set(batch.length);
    localQueue.clear();
    this.inputQueueSizeGauge.labels(gameId).set(0);
    this.flushUpdatesCounter.labels(gameId).inc(batch.length);

    if (Logger.isLevelEnabled('debug')) {
      this.logger.debug(
        `[writeRoom] redis write — gameId=${gameId} batchSize=${batch.length} ` +
          batch.map((m) => `${m.playerId}(${m.positionX},${m.positionY})`).join(' ')
      );
    }

    let seq: number;
    try {
      seq = await this.execFlush(gameId, batch);
    } catch (err) {
      this.logger.error(`execFlush error for room ${gameId}: ${(err as Error).message}`);
      return;
    }

    const elapsed = Date.now() - writeStart;
    this.logger.debug(
      `[writeRoom] done — gameId=${gameId} seq=${seq} batchSize=${batch.length} elapsed=${elapsed}ms`
    );

    // TICKET-002: split alive / dead for the OUT phase
    const aliveUpdates: PositionUpdate[] = [];
    const deadMessages: PositionMessage[] = [];
    for (const msg of batch) {
      if (msg.isAlive === SurvivalStatus.ALIVE) {
        aliveUpdates.push({ playerId: msg.playerId, playerPosition: [msg.positionX, msg.positionY] });
      } else {
        deadMessages.push(msg);
      }
    }

    // Buffer for the OUT timer
    const pending = this.pendingBroadcasts.get(gameId);
    if (pending) {
      pending.push({ seq, aliveUpdates, deadMessages });
    } else {
      this.pendingBroadcasts.set(gameId, [{ seq, aliveUpdates, deadMessages }]);
    }
  }

  // ── Private: OUT timer (broadcast) ────────────────────────────────────────

  private broadcastSlot(slotIndex: number): void {
    for (const gameId of this.outTimers[slotIndex].rooms) {
      try {
        this.broadcastRoom(gameId);
      } catch (err) {
        this.logger.error(`broadcastRoom error for room ${gameId}: ${(err as Error).message}`);
      }
    }
  }

  /**
   * OUT phase: drain pendingBroadcasts → socket.io emit.
   * Runs ~POSITION_BATCH_TIME/2 ms after writeRoom to ensure Redis writes complete first.
   *
   * mergeBatches — collapse N accumulated batches into one (latest position per player).
   * Prevents the O(N×sockets) positive-feedback loop when the event loop falls behind.
   */
  private broadcastRoom(gameId: string): void {
    const pending = this.pendingBroadcasts.get(gameId);
    if (!pending || pending.length === 0) return;

    const batches = pending.splice(0); // drain atomically
    if (!this.server) return;

    const { seq, aliveUpdates, deadMessages } = this.mergeBatches(batches);
    const broadcastStart = Date.now();

    if (aliveUpdates.length > 0) {
      const socketIds = [...(this.playerSocketMap.get(gameId)?.values() ?? [])];
      this.server.to(socketIds).emit(SocketEvents.UPDATE_POSITION, { seq, updates: aliveUpdates });
    }

    if (deadMessages.length > 0) {
      this.broadcastToDeadPlayers(gameId, seq, deadMessages);
    }

    const aliveIds = aliveUpdates.map((u) => u.playerId).join(',');
    const deadIds = deadMessages.map((m) => m.playerId).join(',');
    this.logger.debug(
      `[broadcastRoom] emit — gameId=${gameId} seq=${seq} mergedBatches=${batches.length} ` +
        `alive=${aliveUpdates.length}[${aliveIds}] dead=${deadMessages.length}[${deadIds}]`
    );

    const elapsed = Date.now() - broadcastStart;
    this.flushDurationHistogram.labels(gameId).observe(elapsed);
    if (elapsed > POSITION_BATCH_TIME * 0.8) {
      this.logger.warn(
        `Room ${gameId} broadcast took ${elapsed}ms (>${POSITION_BATCH_TIME * 0.8}ms threshold)`
      );
    }
  }

  /**
   * N개 누적 배치를 플레이어당 최신 위치 하나로 병합한다.
   *
   * 배치를 오래된 순서로 순회하며 Map.set으로 덮어쓰면 마지막 값(=최신)이 자동으로 남는다.
   * 결과 seq는 가장 마지막 배치의 값을 사용한다.
   */
  private mergeBatches(
    batches: Array<{ seq: number; aliveUpdates: PositionUpdate[]; deadMessages: PositionMessage[] }>
  ): { seq: number; aliveUpdates: PositionUpdate[]; deadMessages: PositionMessage[] } {
    const seq = batches[batches.length - 1].seq;
    const aliveMap = new Map<string, PositionUpdate>();
    const deadMap = new Map<string, PositionMessage>();
    for (const batch of batches) {
      for (const u of batch.aliveUpdates) aliveMap.set(u.playerId, u);
      for (const m of batch.deadMessages) deadMap.set(m.playerId, m);
    }
    return { seq, aliveUpdates: [...aliveMap.values()], deadMessages: [...deadMap.values()] };
  }

  /**
   * Runs the Lua script when available; falls back to a non-atomic pipeline otherwise.
   * The pipeline fallback is used in tests (ioredis-mock) and restricted Redis deployments.
   */
  private async execFlush(gameId: string, batch: PositionMessage[]): Promise<number> {
    if (this.luaAvailable) {
      try {
        return await this.execFlushLua(gameId, batch);
      } catch (err) {
        const msg = (err as Error).message ?? '';
        if (msg.includes('NOSCRIPT')) {
          // Script evicted — reload once and retry
          try {
            this.luaSha = (await this.redis.script('LOAD', LUA_POSITION_FLUSH)) as string;
            return await this.execFlushLua(gameId, batch);
          } catch {
            this.luaAvailable = false;
            this.logger.warn('Lua reload failed — switching to pipeline fallback');
          }
        } else {
          throw err;
        }
      }
    }
    return this.execFlushPipeline(gameId, batch);
  }

  /** Lua-based atomic flush (TICKET-005). */
  private async execFlushLua(gameId: string, batch: PositionMessage[]): Promise<number> {
    const n = batch.length;
    const playerKeys: string[] = new Array(n);
    const posXArgs: string[] = new Array(n);
    const posYArgs: string[] = new Array(n);
    const isAliveArgs: string[] = new Array(n);
    const playerIdArgs: string[] = new Array(n);

    for (let i = 0; i < n; i++) {
      const m = batch[i];
      playerKeys[i] = REDIS_KEY.PLAYER(m.playerId);
      posXArgs[i] = m.positionX.toString();
      posYArgs[i] = m.positionY.toString();
      isAliveArgs[i] = m.isAlive;
      playerIdArgs[i] = m.playerId;
    }

    const keys = [
      REDIS_KEY.ROOM_SEQ(gameId),
      REDIS_KEY.POSITION_CHANNEL(gameId),
      REDIS_KEY.ROOM_POSITION_LOG(gameId),
      ...playerKeys
    ];
    const args = [
      this.serverId,
      gameId,
      POSITION_HISTORY_SIZE.toString(),
      ...posXArgs,
      ...posYArgs,
      ...isAliveArgs,
      ...playerIdArgs
    ];
    const result = await (this.redis as any).evalsha(this.luaSha, keys.length, ...keys, ...args);
    return result as number;
  }

  /**
   * Non-atomic pipeline fallback used when Lua is unavailable (e.g. ioredis-mock, tests).
   * Provides the same external behaviour but without atomicity guarantees.
   */
  private async execFlushPipeline(gameId: string, batch: PositionMessage[]): Promise<number> {
    const pipeline = this.redis.pipeline();
    batch.forEach((m) =>
      pipeline.hmset(REDIS_KEY.PLAYER(m.playerId), {
        positionX: m.positionX.toString(),
        positionY: m.positionY.toString()
      })
    );
    pipeline.incr(REDIS_KEY.ROOM_SEQ(gameId));
    const results = await pipeline.exec();

    const seqResult = results?.[batch.length];
    const seq = (seqResult?.[1] as number) ?? 0;

    // Publish and append log outside the pipeline (non-atomic)
    const logEntry = JSON.stringify({
      seq,
      updates: batch.map((m) => ({
        playerId: m.playerId,
        positionX: m.positionX,
        positionY: m.positionY,
        isAlive: m.isAlive
      }))
    });
    const pubPayload = JSON.stringify({
      serverId: this.serverId,
      gameId,
      seq,
      updates: batch.map((m) => ({
        playerId: m.playerId,
        playerPosition: [m.positionX, m.positionY],
        isAlive: m.isAlive
      }))
    });

    await Promise.all([
      this.redis.publish(REDIS_KEY.POSITION_CHANNEL(gameId), pubPayload),
      this.redis.rpush(REDIS_KEY.ROOM_POSITION_LOG(gameId), logEntry).then(() =>
        this.redis.ltrim(REDIS_KEY.ROOM_POSITION_LOG(gameId), -POSITION_HISTORY_SIZE, -1)
      )
    ]);

    return seq;
  }

  /**
   * Handles a position batch received from another WAS instance via pub/sub.
   *
   * Flow:
   *   1. Filter out self-published messages (serverId === this.serverId → already handled by OUT timer).
   *   2. Ignore if this WAS has no local clients in the room.
   *   3. Split updates by alive/dead and broadcast with the same visibility policy as broadcastRoom.
   */
  private handlePositionMessage(channel: string, rawMessage: string): void {
    let parsed: {
      serverId: string;
      gameId: string;
      seq: number;
      updates: Array<{ playerId: string; playerPosition: [number, number]; isAlive: string }>;
    };

    try {
      parsed = JSON.parse(rawMessage);
    } catch {
      this.logger.warn(`[positionSub] invalid JSON on channel ${channel}`);
      return;
    }

    const { serverId, gameId, seq, updates } = parsed;

    // Self-published — already handled by the local OUT timer
    if (serverId === this.serverId) return;

    // No local clients in this room on this WAS — nothing to broadcast
    if (!this.localClientCounts.has(gameId)) return;

    // Server may not be initialized yet (rare: message before afterInit)
    if (!this.server) return;

    const aliveUpdates: PositionUpdate[] = [];
    const deadMessages: PositionMessage[] = [];

    for (const u of updates) {
      if (u.isAlive === SurvivalStatus.ALIVE) {
        aliveUpdates.push({ playerId: u.playerId, playerPosition: u.playerPosition });
      } else {
        deadMessages.push({
          playerId: u.playerId,
          positionX: u.playerPosition[0],
          positionY: u.playerPosition[1],
          gameId,
          isAlive: u.isAlive
        });
      }
    }

    if (aliveUpdates.length > 0) {
      const socketIds = [...(this.playerSocketMap.get(gameId)?.values() ?? [])];
      this.server.to(socketIds).emit(SocketEvents.UPDATE_POSITION, { seq, updates: aliveUpdates });
    }
    if (deadMessages.length > 0) {
      this.broadcastToDeadPlayers(gameId, seq, deadMessages);
    }

    this.logger.debug(
      `[positionSub] remote broadcast — gameId=${gameId} seq=${seq} ` +
        `alive=${aliveUpdates.length} dead=${deadMessages.length} fromServer=${serverId.slice(0, 8)}`
    );
  }

  /**
   * 탈락한 플레이어들에게 dead 위치 업데이트를 브로드캐스트한다.
   * Redis 조회 없이 인메모리 playerSocketMap / deadPlayerIds 만 사용한다.
   */
  private broadcastToDeadPlayers(
    gameId: string,
    seq: number,
    deadMessages: PositionMessage[]
  ): void {
    const deadSet = this.deadPlayerIds.get(gameId);
    if (!deadSet || deadSet.size === 0) return;

    const playerMap = this.playerSocketMap.get(gameId);
    if (!playerMap) return;

    const updates = deadMessages.map((m) => ({
      playerId: m.playerId,
      playerPosition: [m.positionX, m.positionY] as [number, number]
    }));

    const socketIds: string[] = [];
    for (const playerId of deadSet) {
      const socketId = playerMap.get(playerId);
      if (socketId) socketIds.push(socketId);
    }

    this.server.to(socketIds).emit(SocketEvents.UPDATE_POSITION, { seq, updates });
  }
}
