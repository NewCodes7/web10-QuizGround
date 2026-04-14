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

  /** Per-instance server ID prevents self-loop in multi-server pub/sub (future use). */
  private readonly serverId = uuidv4();

  private server: Namespace;

  /** Number of clients from this server currently in each room. */
  private localClientCounts = new Map<string, number>();

  /**
   * Slot-based timer array (TICKET-007).
   *
   * Slot assignment strategy:
   *   - Rooms 1..POSITION_MAX_TIMERS → one room per slot (round-robin).
   *   - Room (N > POSITION_MAX_TIMERS) → shares slot at index N % POSITION_MAX_TIMERS.
   *   - Timer count is therefore always ≤ POSITION_MAX_TIMERS regardless of room count.
   *   - Each slot fires independently every POSITION_BATCH_TIME ms, staggered by
   *     (POSITION_BATCH_TIME / POSITION_MAX_TIMERS) ms offsets so that flushes are
   *     spread across time rather than all firing simultaneously.
   */
  private timers: TimerSlot[] = [];
  private roomCounter = 0;

  /**
   * Local input queue (TICKET-003).
   * gameId → (playerId → latest PositionMessage)
   * Overwrite strategy: the most recent updatePosition call wins per player per batch.
   * Filled by enqueueUpdate(); drained every POSITION_BATCH_TIME ms by the timer flush.
   */
  private inputQueue = new Map<string, Map<string, PositionMessage>>();

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
      this.timers.push({ offsetTimeout: null, interval: null, rooms: new Set() });
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
      buckets: [1, 5, 10, 20, 50, 100]
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
  }

  /**
   * Called from GameGateway.afterInit.
   * Sets the Socket.IO namespace and starts all slot timers with staggered offsets.
   */
  initTimers(server: Namespace): void {
    this.server = server;
    const slotOffset = POSITION_BATCH_TIME / POSITION_MAX_TIMERS;
    for (let i = 0; i < POSITION_MAX_TIMERS; i++) {
      const slotIndex = i;
      this.timers[i].offsetTimeout = setTimeout(() => {
        this.timers[slotIndex].interval = setInterval(() => {
          this.flushSlot(slotIndex);
        }, POSITION_BATCH_TIME);
      }, slotIndex * slotOffset);
    }
    this.logger.verbose(
      `Position timer slots started: ${POSITION_MAX_TIMERS} slots × ${POSITION_BATCH_TIME}ms, ${slotOffset}ms offset`
    );
  }

  onApplicationShutdown(): void {
    for (const slot of this.timers) {
      if (slot.offsetTimeout) clearTimeout(slot.offsetTimeout);
      if (slot.interval) clearInterval(slot.interval);
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
    const wasOverwritten = queue.has(message.playerId);
    queue.set(message.playerId, message);
    this.inputQueueSizeGauge.labels(gameId).set(queue.size);

    this.logger.debug(
      `[enqueueUpdate] gameId=${gameId} playerId=${message.playerId} ` +
        `x=${message.positionX} y=${message.positionY} isAlive=${message.isAlive} ` +
        `queueSize=${queue.size} overwritten=${wasOverwritten}`
    );
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

    // TICKET-001: verify the player belongs to this room
    const [playerGameId, requesterIsAlive] = await this.redis.hmget(
      REDIS_KEY.PLAYER(playerId),
      'gameId',
      'isAlive'
    );

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

    // Get authoritative seq from Redis (TICKET-004)
    const currentSeqStr = await this.redis.get(REDIS_KEY.ROOM_SEQ(gameId));
    const currentSeq = parseInt(currentSeqStr ?? '0');

    if (lastSeq >= currentSeq) {
      return; // nothing to retransmit
    }

    // Fetch Redis position log (TICKET-006)
    const rawEntries = await this.redis.lrange(REDIS_KEY.ROOM_POSITION_LOG(gameId), 0, -1);
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
    for (const slot of this.timers) {
      slot.rooms.delete(gameId);
    }
    this.inputQueue.delete(gameId);
    this.inputQueueSizeGauge.labels(gameId).set(0);

    this.redis
      .del(REDIS_KEY.ROOM_SEQ(gameId), REDIS_KEY.ROOM_POSITION_LOG(gameId))
      .catch((err) =>
        this.logger.error(`Redis cleanup failed for room ${gameId}: ${err.message}`)
      );

    this.logger.verbose(`Position input queue cleaned up for room ${gameId}`);
  }

  /** Round-robin slot assignment; warns when a slot hosts more than one room. */
  private assignTimer(gameId: string): void {
    const idx = this.roomCounter % POSITION_MAX_TIMERS;
    this.timers[idx].rooms.add(gameId);
    this.roomCounter++;

    const slotSize = this.timers[idx].rooms.size;
    if (slotSize > 1) {
      this.logger.warn(
        `Slot ${idx} now has ${slotSize} rooms — flush latency per room in this slot may increase`
      );
    }
  }

  // ── Private: flush pipeline ────────────────────────────────────────────────

  private flushSlot(slotIndex: number): void {
    for (const gameId of this.timers[slotIndex].rooms) {
      this.flushRoom(gameId).catch((err) => {
        this.logger.error(`flushRoom error for room ${gameId}: ${err.message}`);
      });
    }
  }

  private async flushRoom(gameId: string): Promise<void> {
    const localQueue = this.inputQueue.get(gameId);
    if (!localQueue || localQueue.size === 0) return;

    const flushStart = Date.now();
    const batch = Array.from(localQueue.values());
    localQueue.clear();
    this.inputQueueSizeGauge.labels(gameId).set(0);
    this.flushUpdatesCounter.labels(gameId).inc(batch.length);

    this.logger.debug(
      `[flushRoom] redis write — gameId=${gameId} batchSize=${batch.length} ` +
        batch.map((m) => `${m.playerId}(${m.positionX},${m.positionY})`).join(' ')
    );

    // TICKET-005: atomic write + seq + log + publish
    let seq: number;
    try {
      seq = await this.execFlush(gameId, batch);
    } catch (err) {
      this.logger.error(`execFlush error for room ${gameId}: ${err.message}`);
      return;
    }

    // TICKET-002: alive/dead separation for broadcast
    const aliveUpdates: PositionUpdate[] = [];
    const deadMessages: PositionMessage[] = [];

    for (const msg of batch) {
      const update: PositionUpdate = {
        playerId: msg.playerId,
        playerPosition: [msg.positionX, msg.positionY]
      };
      if (msg.isAlive === SurvivalStatus.ALIVE) {
        aliveUpdates.push(update);
      } else {
        deadMessages.push(msg);
      }
    }

    if (aliveUpdates.length > 0 && this.server) {
      this.server.to(gameId).emit(SocketEvents.UPDATE_POSITION, { seq, updates: aliveUpdates });
    }
    if (deadMessages.length > 0 && this.server) {
      this.broadcastToDeadPlayers(gameId, seq, deadMessages).catch((err) => {
        this.logger.error(`Dead player broadcast error for room ${gameId}: ${err.message}`);
      });
    }

    const elapsed = Date.now() - flushStart;
    this.flushDurationHistogram.labels(gameId).observe(elapsed);

    if (elapsed > POSITION_BATCH_TIME * 0.8) {
      this.logger.warn(
        `Room ${gameId} flush took ${elapsed}ms (>${POSITION_BATCH_TIME * 0.8}ms threshold)`
      );
    }

    const aliveIds = aliveUpdates.map((u) => u.playerId).join(',');
    const deadIds = deadMessages.map((m) => m.playerId).join(',');
    this.logger.debug(
      `[flushRoom] broadcast — gameId=${gameId} seq=${seq} ` +
        `alive=${aliveUpdates.length}[${aliveIds}] dead=${deadMessages.length}[${deadIds}] elapsed=${elapsed}ms`
    );
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
        if (err.message && err.message.includes('NOSCRIPT')) {
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
    const keys = [
      REDIS_KEY.ROOM_SEQ(gameId),
      REDIS_KEY.POSITION_CHANNEL(gameId),
      REDIS_KEY.ROOM_POSITION_LOG(gameId),
      ...batch.map((m) => REDIS_KEY.PLAYER(m.playerId))
    ];
    const args = [
      this.serverId,
      gameId,
      POSITION_HISTORY_SIZE.toString(),
      ...batch.map((m) => m.positionX.toString()),
      ...batch.map((m) => m.positionY.toString()),
      ...batch.map((m) => m.isAlive),
      ...batch.map((m) => m.playerId)
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

  private async broadcastToDeadPlayers(
    gameId: string,
    seq: number,
    deadMessages: PositionMessage[]
  ): Promise<void> {
    const players = await this.redis.smembers(REDIS_KEY.ROOM_PLAYERS(gameId));
    if (players.length === 0) return;

    const pipeline = this.redis.pipeline();
    players.forEach((id) => pipeline.hmget(REDIS_KEY.PLAYER(id), 'isAlive', 'socketId'));
    type Result = [Error | null, [string, string] | null];
    const results = (await pipeline.exec()) as Result[];

    const updates = deadMessages.map((m) => ({
      playerId: m.playerId,
      playerPosition: [m.positionX, m.positionY] as [number, number]
    }));

    results
      .map(([err, data], index) => ({
        id: players[index],
        isAlive: err ? null : data?.[0],
        socketId: err ? null : data?.[1]
      }))
      .filter((p) => p.isAlive === SurvivalStatus.DEAD)
      .forEach((p) => {
        const socket = this.server.sockets.get(p.socketId);
        if (socket) {
          socket.emit(SocketEvents.UPDATE_POSITION, { seq, updates });
        }
      });
  }
}
