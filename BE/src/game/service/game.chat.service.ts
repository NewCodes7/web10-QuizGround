import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import Redis from 'ioredis';
import { InjectRedis } from '@nestjs-modules/ioredis';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GameValidator } from '../validations/game.validator';
import { ChatMessageModel } from '../entities/chat-message.entity';
import { ChatMessageDto } from '../dto/chat-message.dto';
import { REDIS_KEY } from '../../common/constants/redis-key.constant';
import SocketEvents from '../../common/constants/socket-events';
import { Namespace, Socket } from 'socket.io';
import { TraceClass } from '../../common/interceptor/SocketEventLoggerInterceptor';
import { SurvivalStatus } from '../../common/constants/game';
import {
  CHAT_BATCH_TIME,
  CHAT_MAX_TIMERS,
  CHAT_STREAM_MAXLEN,
  CHAT_BATCH_HISTORY_SIZE
} from '../../common/constants/batch-time';
import { RetransmitChatDto } from '../dto/retransmit-chat.dto';
import { GameWsException } from '../../common/exceptions/game.ws.exception';
import { ExceptionMessage } from '../../common/constants/exception-message';

interface TimerSlot {
  offsetTimeout: NodeJS.Timeout | null;
  interval: NodeJS.Timeout | null;
  rooms: Set<string>;
}

interface ChatInputMessage {
  playerId: string;
  playerName: string;
  message: string;
  timestamp: number;
  /** SurvivalStatus.ALIVE('1') or SurvivalStatus.DEAD('0') */
  isAlive: string;
}

interface ChatBroadcastMessage {
  playerId: string;
  playerName: string;
  message: string;
  timestamp: number;
}

interface BatchLogEntry {
  seq: number;
  messages: ChatBroadcastMessage[];
  /** Parallel to messages — true when the sender was alive (visible to all) */
  isAliveFlags: boolean[];
}

/** MySQL 영속화 주기 (ms) */
const CHAT_PERSIST_INTERVAL = 60_000;
/** 분산 락 TTL — 영속화 주기보다 약간 길게 설정해 WAS 크래시 시 자동 해제 */
const CHAT_PERSIST_LOCK_TTL_SEC = 70;

@TraceClass()
@Injectable()
export class GameChatService implements OnApplicationShutdown {
  private readonly logger = new Logger(GameChatService.name);

  /** WAS 인스턴스 고유 ID — 분산 락 소유자 식별용 */
  private readonly instanceId = uuidv4();

  /** 인메모리 쓰기 큐: gameId → 미전송 메시지 배열 */
  private inputQueue = new Map<string, ChatInputMessage[]>();

  /** XRANGE 읽기 오프셋: gameId → 마지막으로 읽은 stream entry ID */
  private lastStreamIdMap = new Map<string, string>();

  /** 재전송용 최근 배치 로그: gameId → BatchLogEntry[] */
  private batchLogMap = new Map<string, BatchLogEntry[]>();

  /** 슬롯 기반 타이머 (PositionBroadcastService 패턴 참조) */
  private timers: TimerSlot[] = [];
  private roomCounter = 0;

  /** 현재 플러시 중인 방 (중복 실행 방지) */
  private processingRooms = new Set<string>();

  /** 로컬 클라이언트 카운트: gameId → count */
  private localClientCounts = new Map<string, number>();

  /** MySQL 영속화 주기 타이머 */
  private persistTimer: NodeJS.Timeout;

  private server: Namespace;

  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly gameValidator: GameValidator,
    @InjectRepository(ChatMessageModel)
    private readonly chatMessageRepository: Repository<ChatMessageModel>
  ) {
    for (let i = 0; i < CHAT_MAX_TIMERS; i++) {
      this.timers.push({ offsetTimeout: null, interval: null, rooms: new Set() });
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * GameGateway.afterInit에서 호출. 슬롯 기반 타이머를 시작한다.
   * PositionBroadcastService.initTimers와 동일한 패턴.
   */
  initTimers(server: Namespace): void {
    this.server = server;
    const slotOffset = CHAT_BATCH_TIME / CHAT_MAX_TIMERS;
    for (let i = 0; i < CHAT_MAX_TIMERS; i++) {
      const slotIndex = i;
      this.timers[i].offsetTimeout = setTimeout(() => {
        this.timers[slotIndex].interval = setInterval(() => {
          this.flushSlot(slotIndex);
        }, CHAT_BATCH_TIME);
      }, slotIndex * slotOffset);
    }
    this.logger.verbose(
      `Chat timer slots started: ${CHAT_MAX_TIMERS} slots × ${CHAT_BATCH_TIME}ms, ${slotOffset}ms offset`
    );

    // MySQL 영속화 주기 타이머 (분산 락 기반)
    this.persistTimer = setInterval(() => this.persistAllRooms(), CHAT_PERSIST_INTERVAL);
    this.logger.verbose(
      `Chat persist timer started: every ${CHAT_PERSIST_INTERVAL / 1000}s (instanceId=${this.instanceId})`
    );
  }

  onApplicationShutdown(): void {
    for (const slot of this.timers) {
      if (slot.offsetTimeout) clearTimeout(slot.offsetTimeout);
      if (slot.interval) clearInterval(slot.interval);
    }
    if (this.persistTimer) clearInterval(this.persistTimer);
    this.logger.verbose('GameChatService shutdown complete');
  }

  // ── Room lifecycle ─────────────────────────────────────────────────────────

  /**
   * GameRoomService.joinRoom에서 호출.
   * 첫 번째 클라이언트 입장 시 인메모리 큐 초기화 및 타이머 슬롯 배정.
   */
  onRoomJoined(gameId: string): void {
    const count = (this.localClientCounts.get(gameId) ?? 0) + 1;
    this.localClientCounts.set(gameId, count);
    if (count === 1) {
      this.initRoom(gameId);
      this.logger.verbose(`Chat input queue started for room ${gameId}`);
    }
  }

  /**
   * GameRoomService.handlePlayerExit에서 호출.
   * 마지막 클라이언트 퇴장 시 인메모리 상태 및 Redis 키 정리.
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

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * 클라이언트 채팅 메시지를 검증 후 인메모리 큐에 추가한다.
   * 실제 Redis 쓰기는 50ms 타이머 슬롯 플러시 시 수행된다.
   */
  async chatMessage(chatMessage: ChatMessageDto, clientId: string): Promise<void> {
    const { gameId, message } = chatMessage;

    const room = await this.redis.hgetall(REDIS_KEY.ROOM(gameId));
    this.gameValidator.validateRoomExists(SocketEvents.CHAT_MESSAGE, room);

    const player = await this.redis.hgetall(REDIS_KEY.PLAYER(clientId));
    this.gameValidator.validatePlayerInRoom(SocketEvents.CHAT_MESSAGE, gameId, player);

    const queue = this.inputQueue.get(gameId);
    if (!queue) {
      // 분산 WAS 환경에서 이 인스턴스가 해당 방을 처리하지 않는 경우.
      // 클라이언트가 재연결 후 다른 WAS에 붙어 onRoomJoined가 아직 불리지 않은 상태일 수 있다.
      // silently drop 대신 예외를 throw해 클라이언트가 상황을 인지하게 한다.
      this.logger.warn(`[chatMessage] room ${gameId} not active on this WAS — rejected`);
      throw new GameWsException(SocketEvents.CHAT_MESSAGE, ExceptionMessage.UNAUTHORIZED_ROOM_ACCESS);
    }

    queue.push({
      playerId: clientId,
      playerName: player.playerName,
      message,
      timestamp: Date.now(),
      isAlive: player.isAlive ?? SurvivalStatus.ALIVE
    });

    this.logger.verbose(
      `[chatMessage] Room: ${gameId} | playerId: ${clientId} | playerName: ${player.playerName}` +
        ` | isAlive: ${player.isAlive === SurvivalStatus.ALIVE ? '생존자' : '관전자'} | Message: ${message}`
    );
  }

  /**
   * 클라이언트의 채팅 재전송 요청을 처리한다.
   * batchLogMap에서 lastSeq 이후 배치를 조회하고, 없으면 Redis Stream에서 폴백.
   */
  async handleRetransmit(dto: RetransmitChatDto, playerId: string, socket: Socket): Promise<void> {
    const { gameId, lastSeq } = dto;

    const [playerGameId, requesterIsAlive] = await this.redis.hmget(
      REDIS_KEY.PLAYER(playerId),
      'gameId',
      'isAlive'
    );

    if (!playerGameId) {
      throw new GameWsException(SocketEvents.RETRANSMIT_CHAT, ExceptionMessage.NOT_A_PLAYER);
    }
    if (playerGameId !== gameId) {
      throw new GameWsException(
        SocketEvents.RETRANSMIT_CHAT,
        ExceptionMessage.UNAUTHORIZED_ROOM_ACCESS
      );
    }

    const currentSeqStr = await this.redis.get(REDIS_KEY.ROOM_CHAT_SEQ(gameId));
    const currentSeq = parseInt(currentSeqStr ?? '0');

    if (lastSeq >= currentSeq) {
      return; // 재전송할 내용 없음
    }

    const isAliveRequester =
      (requesterIsAlive ?? SurvivalStatus.ALIVE) === SurvivalStatus.ALIVE;
    const batchLog = this.batchLogMap.get(gameId) ?? [];
    const missingEntries = batchLog.filter((e) => e.seq > lastSeq);

    let isFallback = false;
    let messages: ChatBroadcastMessage[] = [];

    if (missingEntries.length > 0) {
      // batchLog에는 alive 발신자 메시지만 기록된다.
      // alive 요청자 / dead 요청자 모두 batchLog 메시지를 수신할 수 있다.
      for (const entry of missingEntries) {
        messages.push(...entry.messages);
      }
    } else {
      // batchLog에 없으면 stream 스캔 폴백.
      // 동시 다중 retransmit 요청 시 Redis 과부하를 막기 위해 COUNT로 상한을 제한한다.
      // CHAT_STREAM_MAXLEN(1000)이 상한이지만 재전송은 최근 메시지만 필요하므로
      // CHAT_BATCH_HISTORY_SIZE × 배치당 최대 메시지 수를 기준으로 여유 있게 제한한다.
      const RETRANSMIT_MAX_COUNT = CHAT_STREAM_MAXLEN;
      isFallback = true;
      this.logger.warn(
        `Chat retransmit fallback — room=${gameId} lastSeq=${lastSeq} currentSeq=${currentSeq}`
      );
      const entries = (await this.redis.xrange(
        REDIS_KEY.ROOM_CHAT_STREAM(gameId),
        '-',
        '+',
        'COUNT' as any,
        RETRANSMIT_MAX_COUNT as any
      )) as [string, string[]][];
      messages = this.parseStreamEntries(entries)
        .filter((m) => !isAliveRequester || m.isAlive === SurvivalStatus.ALIVE)
        .map((m) => ({
          playerId: m.playerId,
          playerName: m.playerName,
          message: m.message,
          timestamp: m.timestamp
        }));
    }

    this.logger.debug(
      `[handleRetransmit] playerId=${playerId} gameId=${gameId} lastSeq=${lastSeq}` +
        ` currentSeq=${currentSeq} isFallback=${isFallback} count=${messages.length}`
    );

    socket.emit(SocketEvents.CHAT_RETRANSMIT_RESPONSE, { seq: currentSeq, messages, isFallback });
  }

  // ── Private: room init/cleanup ─────────────────────────────────────────────

  private initRoom(gameId: string): void {
    this.inputQueue.set(gameId, []);
    this.lastStreamIdMap.set(gameId, '0-0');
    this.batchLogMap.set(gameId, []);
    this.assignTimer(gameId);
  }

  private cleanupRoom(gameId: string): void {
    for (const slot of this.timers) {
      slot.rooms.delete(gameId);
    }
    this.inputQueue.delete(gameId);
    this.lastStreamIdMap.delete(gameId);
    this.batchLogMap.delete(gameId);
    this.processingRooms.delete(gameId);

    this.redis
      .del(
        REDIS_KEY.ROOM_CHAT_STREAM(gameId),
        REDIS_KEY.ROOM_CHAT_SEQ(gameId),
        REDIS_KEY.ROOM_CHAT_PERSIST_CURSOR(gameId),
        REDIS_KEY.ROOM_CHAT_PERSIST_LOCK(gameId)
      )
      .catch((err) =>
        this.logger.error(`Chat Redis cleanup failed for room ${gameId}: ${err.message}`)
      );

    this.logger.verbose(`Chat input queue cleaned up for room ${gameId}`);
  }

  private assignTimer(gameId: string): void {
    const idx = this.roomCounter % CHAT_MAX_TIMERS;
    this.timers[idx].rooms.add(gameId);
    this.roomCounter++;

    const slotSize = this.timers[idx].rooms.size;
    if (slotSize > 1) {
      this.logger.warn(`Chat slot ${idx} now has ${slotSize} rooms`);
    }
  }

  // ── Private: flush pipeline ────────────────────────────────────────────────

  private flushSlot(slotIndex: number): void {
    for (const gameId of this.timers[slotIndex].rooms) {
      this.flushRoom(gameId).catch((err) => {
        this.logger.error(`Chat flushRoom error for room ${gameId}: ${err.message}`);
      });
    }
  }

  /**
   * IN:  인메모리 큐를 Redis Stream에 쓴다 (XADD + XTRIM).
   * OUT: Stream에서 새 항목을 읽어(XRANGE) 클라이언트에 방송한다.
   */
  private async flushRoom(gameId: string): Promise<void> {
    if (this.processingRooms.has(gameId)) return;
    this.processingRooms.add(gameId);

    const flushStart = Date.now();

    try {
      // ── Phase 1: Write ────────────────────────────────────────────────────
      const localQueue = this.inputQueue.get(gameId);
      if (localQueue && localQueue.length > 0) {
        const batch = localQueue.splice(0, localQueue.length);

        this.logger.debug(
          `[flushRoom] stream write — gameId=${gameId} batchSize=${batch.length} ` +
            batch.map((m) => `${m.playerId}("${m.message.slice(0, 20)}")`).join(' ')
        );

        // XADD에 MAXLEN ~ 옵션을 인라인으로 지정한다.
        // 별도 XTRIM을 Phase 1 마지막에 실행하면 방금 쓴 항목이 트림된 후
        // Phase 2의 XRANGE에서 읽지 못해 메시지가 유실될 수 있다 (trim race).
        // XADD 내 트림은 해당 entry 추가 전에 수행되므로 새로 쓴 항목은 항상 안전하다.
        const pipeline = this.redis.pipeline();
        for (const msg of batch) {
          (pipeline as any).xadd(
            REDIS_KEY.ROOM_CHAT_STREAM(gameId),
            'MAXLEN', '~', CHAT_STREAM_MAXLEN,
            '*',
            'playerId', msg.playerId,
            'playerName', msg.playerName,
            'message', msg.message,
            'timestamp', msg.timestamp.toString(),
            'isAlive', msg.isAlive
          );
        }
        await pipeline.exec();

      }

      // ── Phase 2: Read & Broadcast ─────────────────────────────────────────
      const lastStreamId = this.lastStreamIdMap.get(gameId) ?? '0-0';
      // XRANGE exclusive 범위 문법 `(id`는 Redis 6.2+ 필요.
      // 이하 버전에서는 syntax error가 발생하므로 Redis >= 6.2 환경에서만 운영할 것.
      // 첫 읽기(0-0 sentinel)는 처음부터(-), 이후는 exclusive start로 중복 방지.
      const start = lastStreamId === '0-0' ? '-' : `(${lastStreamId}`;
      const entries = (await this.redis.xrange(
        REDIS_KEY.ROOM_CHAT_STREAM(gameId),
        start,
        '+'
      )) as [string, string[]][];

      if (entries.length === 0) return;

      const parsed = this.parseStreamEntries(entries);

      // 마지막으로 읽은 stream ID 갱신
      this.lastStreamIdMap.set(gameId, entries[entries.length - 1][0]);

      const broadcastMessages: ChatBroadcastMessage[] = parsed.map((m) => ({
        playerId: m.playerId,
        playerName: m.playerName,
        message: m.message,
        timestamp: m.timestamp
      }));
      const isAliveFlags = parsed.map((m) => m.isAlive === SurvivalStatus.ALIVE);

      const aliveMessages = broadcastMessages.filter((_, i) => isAliveFlags[i]);
      const deadMessages = broadcastMessages.filter((_, i) => !isAliveFlags[i]);

      // seq는 alive 메시지가 있을 때만 발급한다.
      // dead 전용 배치에서 seq를 INCR하면 alive 클라이언트의 chatSeqMap에
      // 갭이 생겨 불필요한 retransmitChat 폭풍이 발생하기 때문이다.
      if (aliveMessages.length > 0 && this.server) {
        const seq = await this.redis.incr(REDIS_KEY.ROOM_CHAT_SEQ(gameId));

        // 재전송용 배치 로그 업데이트 (alive 메시지만 기록)
        const batchLog = this.batchLogMap.get(gameId);
        if (batchLog) {
          batchLog.push({ seq, messages: aliveMessages, isAliveFlags: aliveMessages.map(() => true) });
          if (batchLog.length > CHAT_BATCH_HISTORY_SIZE) {
            batchLog.splice(0, batchLog.length - CHAT_BATCH_HISTORY_SIZE);
          }
        }

        this.server.to(gameId).emit(SocketEvents.CHAT_MESSAGE, { seq, messages: aliveMessages });
      }

      // dead 발신자 메시지 → dead 플레이어에게만 전송 (seq 없이 별도 채널)
      if (deadMessages.length > 0 && this.server) {
        await this.broadcastToDeadPlayers(gameId, deadMessages);
      }

      const elapsed = Date.now() - flushStart;

      if (elapsed > CHAT_BATCH_TIME * 0.8) {
        this.logger.warn(
          `Room ${gameId} chat flush took ${elapsed}ms (>${CHAT_BATCH_TIME * 0.8}ms threshold)`
        );
      }

      const aliveIds = aliveMessages.map((m) => m.playerId).join(',');
      const deadIds = deadMessages.map((m) => m.playerId).join(',');
      this.logger.debug(
        `[flushRoom] broadcast — gameId=${gameId} ` +
          `alive=${aliveMessages.length}[${aliveIds}] dead=${deadMessages.length}[${deadIds}] elapsed=${elapsed}ms`
      );
    } finally {
      this.processingRooms.delete(gameId);
    }
  }

  private parseStreamEntries(
    entries: [string, string[]][]
  ): (ChatBroadcastMessage & { isAlive: string; streamEntryId: string })[] {
    return entries.map(([id, fields]) => {
      const fm: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) {
        fm[fields[i]] = fields[i + 1];
      }
      return {
        streamEntryId: id,
        playerId: fm['playerId'],
        playerName: fm['playerName'],
        message: fm['message'],
        timestamp: parseInt(fm['timestamp']),
        isAlive: fm['isAlive']
      };
    });
  }

  private broadcastToDeadPlayers(gameId: string, messages: ChatBroadcastMessage[]): void {
    // dead 발신자 메시지를 방 전체에 emit하되 isDeadOnly 플래그를 포함한다.
    // FE는 현재 플레이어가 dead일 때만 이 메시지를 렌더링한다.
    //
    // 이전에 Redis에서 socketId를 읽어 this.server.sockets.get()으로 직접 emit했던 방식은
    // 현재 WAS 인스턴스에 연결된 소켓만 찾을 수 있어 다른 WAS에 연결된 dead 플레이어가
    // 메시지를 수신하지 못하는 문제(로컬 소켓 맵 의존)가 있었다.
    // server.to(gameId).emit은 Socket.IO Redis Adapter 도입 시 자동으로 분산 전파된다.
    this.server.to(gameId).emit(SocketEvents.CHAT_MESSAGE, { messages, isDeadOnly: true });
  }

  // ── Private: MySQL 영속화 (분산 락 기반, 1분 주기) ─────────────────────────

  /**
   * 이 WAS가 로컬에 갖고 있는 모든 활성 방에 대해 persist 시도.
   * 락을 얻지 못한 방은 다른 WAS가 처리 중이므로 건너뜀.
   */
  private persistAllRooms(): void {
    for (const gameId of this.inputQueue.keys()) {
      this.persistRoom(gameId).catch((err) =>
        this.logger.error(`[persistRoom] error — gameId=${gameId}: ${err.message}`)
      );
    }
  }

  /**
   * 분산 락(SET NX EX)을 획득한 WAS만 해당 방의 미저장 메시지를 MySQL에 저장한다.
   *
   * - 락 TTL(70s) > 영속화 주기(60s): WAS 크래시 시 다음 주기에 다른 WAS가 자동 인계
   * - 커서(ChatPersistCursor)로 마지막 저장 stream ID를 추적해 중복 저장 방지
   * - XRANGE 배타적 범위((cursor +)로 저장된 항목 재조회 없음
   */
  private async persistRoom(gameId: string): Promise<void> {
    const lockKey = REDIS_KEY.ROOM_CHAT_PERSIST_LOCK(gameId);
    const cursorKey = REDIS_KEY.ROOM_CHAT_PERSIST_CURSOR(gameId);

    // 분산 락 획득 시도 (NX = 없을 때만 SET, EX = TTL)
    // ioredis v5: SET key value EX ttl NX
    const acquired = await this.redis.set(
      lockKey,
      this.instanceId,
      'EX',
      CHAT_PERSIST_LOCK_TTL_SEC,
      'NX'
    );
    if (!acquired) {
      this.logger.debug(`[persistRoom] lock not acquired — gameId=${gameId} (another WAS holds it)`);
      return;
    }

    try {
      const cursor = await this.redis.get(cursorKey);
      // XRANGE exclusive 범위 `(id`는 Redis 6.2+ 필요 (flushRoom Phase 2와 동일).
      // cursor가 없으면 스트림 처음부터(-), 있으면 해당 ID 이후(배타적)만 읽기.
      const start = cursor ? `(${cursor}` : '-';
      const entries = (await this.redis.xrange(
        REDIS_KEY.ROOM_CHAT_STREAM(gameId),
        start,
        '+'
      )) as [string, string[]][];

      if (entries.length === 0) {
        this.logger.debug(`[persistRoom] nothing to persist — gameId=${gameId}`);
        return;
      }

      const rows = this.parseStreamEntries(entries).map((m) => ({
        gameId,
        streamEntryId: m.streamEntryId,
        playerId: m.playerId,
        playerName: m.playerName,
        message: m.message,
        isAlive: m.isAlive === SurvivalStatus.ALIVE,
        sentAt: new Date(m.timestamp)
      }));

      // orIgnore(): stream_entry_id unique 위반 시 해당 행을 건너뜀 (INSERT IGNORE).
      // cursor 갱신 실패로 다음 주기에 재시도하더라도 이미 저장된 항목은 중복 삽입되지 않는다.
      await this.chatMessageRepository.createQueryBuilder().insert().into(ChatMessageModel).values(rows).orIgnore().execute();

      // 마지막으로 저장한 stream ID를 커서로 갱신
      const newCursor = entries[entries.length - 1][0];
      await this.redis.set(cursorKey, newCursor);

      this.logger.verbose(
        `[persistRoom] saved — gameId=${gameId} count=${rows.length} cursor=${newCursor}`
      );
    } finally {
      // 락 소유자인 경우에만 원자적으로 해제.
      // GET + DEL을 분리하면 TTL 만료 후 다른 WAS가 획득한 락을 날릴 수 있어(TOCTOU),
      // Lua 스크립트로 단일 명령어 내에서 확인과 삭제를 처리한다.
      const releaseLockScript = `
        if redis.call('get', KEYS[1]) == ARGV[1] then
          return redis.call('del', KEYS[1])
        else
          return 0
        end
      `;
      await this.redis.eval(releaseLockScript, 1, lockKey, this.instanceId);
    }
  }
}
