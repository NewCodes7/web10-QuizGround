import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { Namespace, Socket } from 'socket.io';
import { REDIS_KEY } from '../../common/constants/redis-key.constant';
import { SurvivalStatus } from '../../common/constants/game';
import SocketEvents from '../../common/constants/socket-events';
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

interface SeqHistoryEntry {
  seq: number;
  playerIds: string[];
}

interface TimerSlot {
  offsetTimeout: NodeJS.Timeout | null;
  interval: NodeJS.Timeout | null;
  rooms: Set<string>;
}

@Injectable()
export class PositionBroadcastService implements OnApplicationShutdown {
  private readonly logger = new Logger(PositionBroadcastService.name);

  private server: Namespace;

  // 방 단위 로컬 클라이언트 카운트 및 구독 연결
  private localClientCounts = new Map<string, number>();
  private roomSubscribers = new Map<string, Redis>();

  // MAX_TIMERS개의 슬롯 타이머 (50ms 주기, 5ms 오프셋)
  private timers: TimerSlot[] = [];
  private roomCounter = 0;

  // 배치 큐 및 시퀀스
  private pendingUpdates = new Map<string, PositionMessage[]>();
  private roomSeq = new Map<string, number>();
  private seqHistory = new Map<string, SeqHistoryEntry[]>();

  constructor(@InjectRedis() private readonly redis: Redis) {
    for (let i = 0; i < POSITION_MAX_TIMERS; i++) {
      this.timers.push({ offsetTimeout: null, interval: null, rooms: new Set() });
    }
  }

  /**
   * 서버 초기화 후 호출 — 모든 슬롯 타이머를 오프셋을 두어 시작
   */
  initTimers(server: Namespace): void {
    this.server = server;
    const slotOffset = POSITION_BATCH_TIME / POSITION_MAX_TIMERS; // 5ms
    for (let i = 0; i < POSITION_MAX_TIMERS; i++) {
      const slotIndex = i;
      this.timers[i].offsetTimeout = setTimeout(() => {
        this.timers[slotIndex].interval = setInterval(() => {
          this.flushSlot(slotIndex);
        }, POSITION_BATCH_TIME);
      }, slotIndex * slotOffset);
    }
    this.logger.verbose(
      `Position timer slots initialized: ${POSITION_MAX_TIMERS} slots, ${POSITION_BATCH_TIME}ms interval, ${slotOffset}ms offset`
    );
  }

  /**
   * 클라이언트가 방에 입장할 때 호출 — 첫 클라이언트면 구독 시작
   */
  onRoomJoined(gameId: string): void {
    const count = (this.localClientCounts.get(gameId) ?? 0) + 1;
    this.localClientCounts.set(gameId, count);

    if (count === 1) {
      this.subscribeToRoom(gameId);
      this.assignTimer(gameId);
      this.logger.verbose(`Position subscription started for room ${gameId}`);
    }
  }

  /**
   * 클라이언트가 방에서 퇴장할 때 호출 — 마지막 클라이언트면 구독 해제
   */
  onRoomLeft(gameId: string): void {
    const current = this.localClientCounts.get(gameId) ?? 0;
    if (current <= 1) {
      this.localClientCounts.delete(gameId);
      this.unsubscribeFromRoom(gameId);
    } else {
      this.localClientCounts.set(gameId, current - 1);
    }
  }

  /**
   * 클라이언트가 누락된 seq 구간의 재전송을 요청할 때 호출
   */
  async handleRetransmit(gameId: string, lastSeq: number, socket: Socket): Promise<void> {
    const currentSeq = this.roomSeq.get(gameId) ?? 0;
    const history = this.seqHistory.get(gameId) ?? [];

    // lastSeq 이후의 배치들에서 playerId 수집
    const missingBatches = history.filter((h) => h.seq > lastSeq);

    let playerIds: string[];
    const oldestHistorySeq = history[0]?.seq ?? currentSeq;

    if (missingBatches.length === 0 || lastSeq < oldestHistorySeq - 1) {
      // 링 버퍼 범위 밖 — 전체 플레이어 현재 위치로 폴백
      playerIds = await this.redis.smembers(REDIS_KEY.ROOM_PLAYERS(gameId));
    } else {
      // 누락된 배치에 포함된 플레이어만
      const playerIdSet = new Set<string>();
      missingBatches.forEach((b) => b.playerIds.forEach((id) => playerIdSet.add(id)));
      playerIds = Array.from(playerIdSet);
    }

    if (playerIds.length === 0) {
      return;
    }

    // 해당 플레이어들의 현재 위치를 Redis에서 조회
    const pipeline = this.redis.pipeline();
    playerIds.forEach((id) => pipeline.hmget(REDIS_KEY.PLAYER(id), 'positionX', 'positionY'));

    type PosResult = [Error | null, [string, string] | null];
    const results = (await pipeline.exec()) as PosResult[];

    const updates = results
      .map((result, index) => {
        const [err, data] = result;
        if (err || !data) return null;
        return {
          playerId: playerIds[index],
          playerPosition: [
            parseFloat(data[0] ?? '0'),
            parseFloat(data[1] ?? '0')
          ] as [number, number],
          appliedSeq: currentSeq
        };
      })
      .filter((u): u is NonNullable<typeof u> => u !== null);

    socket.emit(SocketEvents.POSITION_RETRANSMIT_RESPONSE, {
      seq: currentSeq,
      retransmitted: true,
      updates
    });
  }

  private subscribeToRoom(gameId: string): void {
    const subscriber = this.redis.duplicate();
    const channel = REDIS_KEY.POSITION_CHANNEL(gameId);

    subscriber.subscribe(channel);
    subscriber.on('message', (_ch: string, message: string) => {
      try {
        const msg = JSON.parse(message) as PositionMessage;
        const queue = this.pendingUpdates.get(gameId);
        if (queue) {
          queue.push(msg);
        }
      } catch {
        // 파싱 오류 무시
      }
    });

    this.roomSubscribers.set(gameId, subscriber);
    this.pendingUpdates.set(gameId, []);
    this.roomSeq.set(gameId, 0);
    this.seqHistory.set(gameId, []);
  }

  private unsubscribeFromRoom(gameId: string): void {
    const subscriber = this.roomSubscribers.get(gameId);
    if (!subscriber) return;

    subscriber.unsubscribe(REDIS_KEY.POSITION_CHANNEL(gameId));
    subscriber.disconnect();
    this.roomSubscribers.delete(gameId);

    // 타이머 슬롯에서 방 제거
    for (const slot of this.timers) {
      slot.rooms.delete(gameId);
    }

    this.pendingUpdates.delete(gameId);
    this.roomSeq.delete(gameId);
    this.seqHistory.delete(gameId);
    this.logger.verbose(`Position subscription stopped for room ${gameId}`);
  }

  /**
   * 라운드 로빈으로 슬롯 배정
   * — 첫 10개 방: 각각 0~9번 슬롯
   * — 11번째 이후: 0번부터 다시 순환
   */
  private assignTimer(gameId: string): void {
    const idx = this.roomCounter % POSITION_MAX_TIMERS;
    this.timers[idx].rooms.add(gameId);
    this.roomCounter++;
  }

  private flushSlot(slotIndex: number): void {
    for (const gameId of this.timers[slotIndex].rooms) {
      this.flushRoom(gameId);
    }
  }

  private flushRoom(gameId: string): void {
    const queue = this.pendingUpdates.get(gameId);
    if (!queue || queue.length === 0) return;

    const batch = queue.splice(0, queue.length);
    const seq = (this.roomSeq.get(gameId) ?? 0) + 1;
    this.roomSeq.set(gameId, seq);

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

    // 재전송을 위한 시퀀스 히스토리 갱신
    const history = this.seqHistory.get(gameId) ?? [];
    history.push({ seq, playerIds: batch.map((m) => m.playerId) });
    if (history.length > POSITION_HISTORY_SIZE) {
      history.shift();
    }
    this.seqHistory.set(gameId, history);

    this.logger.debug(
      `Room ${gameId} flushed: seq=${seq}, alive=${aliveUpdates.length}, dead=${deadMessages.length}`
    );
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

  onApplicationShutdown(): void {
    for (const slot of this.timers) {
      if (slot.offsetTimeout) clearTimeout(slot.offsetTimeout);
      if (slot.interval) clearInterval(slot.interval);
    }
    for (const [, subscriber] of this.roomSubscribers) {
      subscriber.disconnect();
    }
    this.logger.verbose('PositionBroadcastService shutdown complete');
  }
}
