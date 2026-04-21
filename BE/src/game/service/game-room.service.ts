import { Injectable, Logger } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { GameValidator } from '../middleware/game.validator';
import { CreateGameDto } from '../dto/create-game.dto';
import { REDIS_KEY } from '../../common/constants/redis-key.constant';
import { generateUniquePin } from '../../common/utils/utils';
import SocketEvents from '../../common/constants/socket-events';
import { UpdateRoomOptionDto } from '../dto/update-room-option.dto';
import { UpdateRoomQuizsetDto } from '../dto/update-room-quizset.dto';
import { Socket } from 'socket.io';
import { KickRoomDto } from '../dto/kick-room.dto';
import { TraceClass } from '../../common/interceptor/SocketEventLoggerInterceptor';
import { SurvivalStatus } from '../../common/constants/game';
import { PositionBroadcastService } from './position-broadcast.service';
import { GameChatService } from './game-chat.service';
import { MetricService } from '../../metric/metric.service';

@TraceClass()
@Injectable()
export class GameRoomService {
  private readonly logger = new Logger(GameRoomService.name);
  private readonly INACTIVE_THRESHOLD = 30 * 60 * 1000; // 30분 30 * 60 * 1000;

  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly gameValidator: GameValidator,
    private readonly positionBroadcastService: PositionBroadcastService,
    private readonly gameChatService: GameChatService,
    private readonly metricService: MetricService
  ) {}

  async createRoom(gameConfig: CreateGameDto, clientId: string): Promise<string> {
    const currentRoomPins = await this.redis.smembers(REDIS_KEY.ACTIVE_ROOMS);
    const roomId = generateUniquePin(currentRoomPins);

    await this.redis.hset(REDIS_KEY.ROOM(roomId), {
      host: clientId,
      status: 'waiting',
      title: gameConfig.title,
      gameMode: gameConfig.gameMode,
      maxPlayerCount: gameConfig.maxPlayerCount.toString(),
      isPublic: gameConfig.isPublic ? '1' : '0',
      isWaiting: '1',
      lastActivityAt: new Date().getTime().toString(),
      quizSetId: '-1', // 미설정시 기본퀴즈를 진행, -1은 기본 퀴즈셋
      quizCount: '2',
      quizSetTitle: '기본 퀴즈셋'
    });

    await this.redis.sadd(REDIS_KEY.ACTIVE_ROOMS, roomId);
    this.logger.verbose(`게임 방 생성 완료: ${roomId}`);

    return roomId;
  }

  async joinRoom(client: Socket, gameId: string, clientId: string) {
    const roomKey = REDIS_KEY.ROOM(gameId);
    const room = await this.redis.hgetall(roomKey);
    this.gameValidator.validateRoomExists(SocketEvents.JOIN_ROOM, room);

    const currentPlayers = await this.redis.smembers(REDIS_KEY.ROOM_PLAYERS(gameId));
    if (room.status !== 'waiting' || room.isWaiting != '1') {
      // 게임 진행 중
      // 재접속 여부 체크 후 처리
      if (!(await this.redis.exists(REDIS_KEY.PLAYER(clientId)))) {
        this.gameValidator.validateRoomProgress(
          SocketEvents.JOIN_ROOM,
          room.status,
          room.isWaiting
        );
      }
      const playerData = await this.redis.hgetall(REDIS_KEY.PLAYER(clientId));
      if (playerData.gameId !== gameId) {
        this.gameValidator.validateRoomProgress(
          SocketEvents.JOIN_ROOM,
          room.status,
          room.isWaiting
        );
      }

      client.join(gameId);
      this.positionBroadcastService.onRoomJoined(gameId);
      this.gameChatService.onRoomJoined(gameId);

      await this.redis.hset(REDIS_KEY.PLAYER(clientId), {
        socketId: client.id
      });
      this.positionBroadcastService.onPlayerJoined(gameId, clientId, client.id);

      await this.sendCurrentInformation(client, gameId, clientId, currentPlayers);
      return;
    }

    this.gameValidator.validateRoomCapacity(
      SocketEvents.JOIN_ROOM,
      currentPlayers.length,
      parseInt(room.maxPlayerCount)
    );

    const playerKey = REDIS_KEY.PLAYER(clientId);
    const playerData = await this.redis.hgetall(playerKey);
    if (playerData && playerData?.gameId) {
      await this.handlePlayerExit(clientId);
      client.leave(playerData.gameId);
    }

    client.join(gameId); //validation 후에 조인해야함
    this.positionBroadcastService.onRoomJoined(gameId);
    this.gameChatService.onRoomJoined(gameId);

    // onRoomJoined 이후 예외가 발생하면 onRoomLeft를 호출해 카운트 불균형을 방지한다.
    try {
      const positionX = Math.random();
      const positionY = Math.random();

      await this.redis.hset(playerKey, {
        playerName: '', //이래야 프론트에서 모달을 띄워주는 조건
        positionX: positionX.toString(),
        positionY: positionY.toString(),
        disconnected: '0',
        gameId: gameId,
        isAlive: SurvivalStatus.ALIVE,
        socketId: client.id
      });
      this.positionBroadcastService.onPlayerJoined(gameId, clientId, client.id);

      await this.redis.zadd(REDIS_KEY.ROOM_LEADERBOARD(gameId), 0, clientId);
      await this.redis.sadd(REDIS_KEY.ROOM_PLAYERS(gameId), clientId);

      // fire-and-forget — 메트릭 실패가 게임 로직에 영향 주지 않도록
      this.redis.scard(REDIS_KEY.ROOM_PLAYERS(gameId))
        .then(count => this.metricService.setRoomPlayerCount(gameId, count))
        .catch(() => {});

      const isHost = (await this.redis.hget(REDIS_KEY.ROOM(gameId), 'host')) === clientId;
      await this.redis.publish(
        `playerState:${gameId}`,
        JSON.stringify({ type: 'Join', playerId: clientId, playerName: '', positionX, positionY, isHost })
      );

      this.logger.verbose(`게임 방 입장 완료: ${gameId} - ${clientId}`);
      await this.sendCurrentInformation(client, gameId, clientId, currentPlayers);
    } catch (err) {
      this.positionBroadcastService.onRoomLeft(gameId);
      this.gameChatService.onRoomLeft(gameId);
      throw err;
    }
  }

  async sendCurrentInformation(
    client: Socket,
    gameId: string,
    clientId: string,
    currentPlayers: string[]
  ) {
    const players = [];
    const roomData = await this.redis.hgetall(REDIS_KEY.ROOM(gameId));

    for (const playerId of currentPlayers) {
      const player = await this.redis.hgetall(REDIS_KEY.PLAYER(playerId));
      const isHost = roomData.host === playerId;
      players.push({
        playerId,
        playerName: player.playerName,
        playerPosition: [parseFloat(player.positionX), parseFloat(player.positionY)],
        isHost
      });
    }

    client.emit(SocketEvents.UPDATE_ROOM_OPTION, {
      title: roomData.title,
      gameMode: roomData.gameMode,
      maxPlayerCount: parseInt(roomData.maxPlayerCount),
      isPublic: roomData.isPublic === '1'
    });
    client.emit(SocketEvents.UPDATE_ROOM_QUIZSET, {
      quizSetId: roomData.quizSetId,
      quizCount: parseInt(roomData.quizCount)
    });

    client.emit(SocketEvents.GET_SELF_ID, { playerId: clientId });
    client.emit(SocketEvents.JOIN_ROOM, { players });

    if (roomData.status !== 'waiting' || roomData.isWaiting != '1') {
      client.emit(SocketEvents.START_GAME, '');
    }
  }

  async updateRoomOption(updateRoomOptionDto: UpdateRoomOptionDto, clientId: string) {
    const { gameId, gameMode, title, maxPlayerCount, isPublic } = updateRoomOptionDto;
    const roomKey = `Room:${gameId}`;

    const room = await this.redis.hgetall(roomKey);
    this.gameValidator.validateRoomExists(SocketEvents.UPDATE_ROOM_OPTION, room);

    this.gameValidator.validatePlayerIsHost(SocketEvents.UPDATE_ROOM_OPTION, room, clientId);

    await this.redis.hset(roomKey, {
      title: title,
      gameMode: gameMode,
      maxPlayerCount: maxPlayerCount.toString(),
      isPublic: isPublic ? '1' : '0'
    });
    await this.redis.publish(
      `roomState:${gameId}`,
      JSON.stringify({ type: 'Option', title, gameMode, maxPlayerCount, isPublic })
    );
    this.logger.verbose(`게임방 옵션 변경: ${gameId}`);
  }

  async updateRoomQuizset(updateRoomQuizsetDto: UpdateRoomQuizsetDto, clientId: string) {
    const { gameId, quizSetId, quizCount } = updateRoomQuizsetDto;
    const roomKey = `Room:${gameId}`;

    const room = await this.redis.hgetall(roomKey);
    this.gameValidator.validateRoomExists(SocketEvents.UPDATE_ROOM_QUIZSET, room);

    this.gameValidator.validatePlayerIsHost(SocketEvents.UPDATE_ROOM_QUIZSET, room, clientId);

    await this.redis.hset(roomKey, {
      quizSetId: quizSetId.toString(),
      quizCount: quizCount.toString()
    });
    await this.redis.publish(
      `roomState:${gameId}`,
      JSON.stringify({ type: 'Quizset', quizSetId, quizCount })
    );
    this.logger.verbose(`게임방 퀴즈셋 변경: ${gameId}`);
  }

  /**
   * 플레이어 퇴장 처리
   */
  async handlePlayerExit(clientId: string): Promise<void> {
    const playerKey = REDIS_KEY.PLAYER(clientId);
    const player = await this.redis.hgetall(playerKey);
    const roomId = player.gameId;

    // 게임 상태와 무관하게 로컬 클라이언트 카운트 감소
    if (roomId) {
      this.positionBroadcastService.onRoomLeft(roomId);
      this.positionBroadcastService.onPlayerLeft(roomId, clientId);
      this.gameChatService.onRoomLeft(roomId);
    }

    const roomKey = REDIS_KEY.ROOM(roomId);
    const room = await this.redis.hgetall(roomKey);
    if (room.status !== 'waiting' || room.isWaiting != '1') {
      return;
    }

    const pipeline = this.redis.pipeline();

    // 플레이어 제거
    const roomPlayersKey = REDIS_KEY.ROOM_PLAYERS(roomId);
    const roomLeaderboardKey = REDIS_KEY.ROOM_LEADERBOARD(roomId);
    pipeline.srem(roomPlayersKey, clientId);
    pipeline.zrem(roomLeaderboardKey, clientId);

    // 1. 플레이어 상태를 'disconnected'로 변경
    pipeline.hset(REDIS_KEY.PLAYER(clientId), {
      disconnected: '1',
      disconnectedAt: Date.now().toString()
    });
    // pipeline.expire(REDIS_KEY.PLAYER(clientId), this.PLAYER_GRACE_PERIOD);

    await pipeline.exec();

    await this.redis.publish(
      `playerState:${roomId}`,
      JSON.stringify({ type: 'Disconnect', playerId: clientId })
    );

    // 호스트가 방을 나갔을 시
    const host = await this.redis.hget(roomKey, 'host');
    const players = await this.redis.smembers(roomPlayersKey);
    if (host === clientId && players.length > 0) {
      const newHost = await this.redis.srandmember(roomPlayersKey);
      await this.redis.hset(roomKey, { host: newHost });
      await this.redis.publish(
        `roomState:${roomId}`,
        JSON.stringify({ type: 'Host', hostId: newHost })
      );
    }

    const remainingPlayers = await this.redis.scard(roomPlayersKey);
    this.metricService.setRoomPlayerCount(roomId, remainingPlayers);

    if (remainingPlayers === 0) {
      // 마지막 플레이어가 나간 경우
      await this.redis.publish('room:cleanup', roomId);
      this.logger.log(`마지막 플레이어 퇴장으로 방 ${roomId} 정리 시작`);
    }
  }

  /**
   * 방 활동 업데이트
   */
  async updateRoomActivity(roomId: string): Promise<void> {
    await this.redis.hset(REDIS_KEY.ROOM(roomId), 'lastActivityAt', Date.now().toString());
  }

  /**
   * 플레이어 관련 모든 데이터에 TTL 설정
   */
  // private async setTTLForPlayerKeys(clientId: string): Promise<void> {
  //   let cursor = '0';
  //   const pattern = `Player:${clientId}:*`;
  //   const pipeline = this.redis.pipeline();
  //
  //   do {
  //     // SCAN으로 플레이어 관련 키들을 배치로 찾기
  //     const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
  //     cursor = nextCursor;
  //
  //     // 찾은 모든 키에 TTL 설정
  //     for (const key of keys) {
  //       pipeline.expire(key, this.PLAYER_GRACE_PERIOD);
  //     }
  //   } while (cursor !== '0');
  //
  //   await pipeline.exec();
  // }

  async kickRoom(kickRoomDto: KickRoomDto, clientId: string) {
    const { gameId, kickPlayerId } = kickRoomDto;

    const roomKey = REDIS_KEY.ROOM(gameId);
    const room = await this.redis.hgetall(roomKey);
    this.gameValidator.validateRoomExists(SocketEvents.KICK_ROOM, room);
    this.gameValidator.validatePlayerIsHost(SocketEvents.KICK_ROOM, room, clientId);

    const targetPlayerKey = REDIS_KEY.PLAYER(kickPlayerId);
    const targetPlayer = await this.redis.hgetall(targetPlayerKey);
    this.gameValidator.validatePlayerExists(SocketEvents.KICK_ROOM, targetPlayer);
    await this.redis.hset(targetPlayerKey, { isAlive: '0' });
    this.positionBroadcastService.onPlayerDied(gameId, kickPlayerId);
    await this.redis.publish(
      `playerState:${gameId}`,
      JSON.stringify({ type: 'Kicked', playerId: kickPlayerId, gameId })
    );
    // await this.handlePlayerExit(kickPlayerId);
  }
}
