import { Injectable, Logger } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { REDIS_KEY } from '../../common/constants/redis-key.constant';
import { UpdatePositionDto } from '../dto/update-position.dto';
import { GameValidator } from '../middleware/game.validator';
import SocketEvents from '../../common/constants/socket-events';
import { StartGameDto } from '../dto/start-game.dto';
import { Namespace, Socket } from 'socket.io';
import { mockQuizData } from '../../../test/mocks/quiz-data.mock';
import { QuizCacheService } from './quiz-cache.service';
import { SubscriberInitializerService } from '../redis/subscriber-initializer.service';
import { parseHeaderToObject } from '../../common/utils/utils';
import { GameRoomService } from './game-room.service';
import { SetPlayerNameDto } from '../dto/set-player-name.dto';
import { Trace, TraceClass } from '../../common/interceptor/SocketEventLoggerInterceptor';
import { PositionBroadcastService } from './position-broadcast.service';
import { GameWsException } from '../../common/exceptions/game.ws.exception';
import { ExceptionMessage } from '../../common/constants/exception-message';

@TraceClass()
@Injectable()
export class GameSessionService {
  private readonly logger = new Logger(GameSessionService.name);

  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly gameValidator: GameValidator,
    private readonly quizCacheService: QuizCacheService,
    private readonly redisSubscriberService: SubscriberInitializerService,
    private readonly gameRoomService: GameRoomService,
    private readonly positionBroadcastService: PositionBroadcastService
  ) {}

  async updatePosition(updatePosition: UpdatePositionDto, clientId: string): Promise<void> {
    const { gameId, newPosition } = updatePosition as unknown as Record<string, unknown>;
    if (
      typeof gameId !== 'string' ||
      !Array.isArray(newPosition) ||
      newPosition.length !== 2 ||
      typeof newPosition[0] !== 'number' ||
      typeof newPosition[1] !== 'number'
    ) {
      throw new GameWsException(SocketEvents.UPDATE_POSITION, ExceptionMessage.INVALID_INPUT);
    }

    // gameId·isAlive를 인메모리에서 조회해 Redis 왕복을 제거 (핫패스 최적화)
    const playerState = this.positionBroadcastService.getPlayerState(clientId);

    if (!playerState) {
      // handleConnection이 async이므로 transport 연결 직후 클라이언트가 UPDATE_POSITION을
      // 보내면 joinRoom 완료 이전에 도달할 수 있다. 인증 실패 시 handleConnection이
      // disconnect를 호출하므로 null 상태는 join 진행 중인 정상 클라이언트에 한정된다.
      // 첫 몇 개 업데이트를 드랍해도 클라이언트는 계속 전송하므로 무해하다.
      this.logger.debug(`[updatePosition] drop (joining) — playerId=${clientId} gameId=${gameId}`);
      return;
    }

    this.gameValidator.validatePlayerInRoomV2(
      SocketEvents.UPDATE_POSITION,
      gameId,
      playerState.gameId
    );

    this.logger.debug(
      `[updatePosition] recv — playerId=${clientId} gameId=${gameId} ` +
        `x=${newPosition[0]} y=${newPosition[1]} isAlive=${playerState.isAlive ?? '1'}`
    );

    this.positionBroadcastService.enqueueUpdate(gameId, {
      playerId: clientId,
      positionX: newPosition[0],
      positionY: newPosition[1],
      gameId,
      isAlive: playerState.isAlive
    });
  }

  async startGame(startGameDto: StartGameDto, clientId: string) {
    const { gameId } = startGameDto;
    const roomKey = `Room:${gameId}`;

    const room = await this.redis.hgetall(roomKey);
    this.gameValidator.validateRoomExists(SocketEvents.START_GAME, room);

    this.gameValidator.validatePlayerIsHost(SocketEvents.START_GAME, room, clientId);

    /**
     * 퀴즈셋이 설정되어 있지 않으면 기본 퀴즈셋을 사용
     */
    const quizset =
      room.quizSetId === '-1'
        ? mockQuizData
        : await this.quizCacheService.getQuizSet(+room.quizSetId);

    //roomKey에 해당하는 room에 quizSetTitle을 quizset.title로 설정
    await this.redis.hset(roomKey, {
      quizSetTitle: quizset.title
    });

    this.gameValidator.validateQuizsetCount(
      SocketEvents.START_GAME,
      parseInt(room.quizCount),
      quizset.quizList.length
    );

    // Room Quiz 초기화
    const prevQuizList = await this.redis.smembers(REDIS_KEY.ROOM_QUIZ_SET(gameId));
    for (const prevQuiz of prevQuizList) {
      await this.redis.del(REDIS_KEY.ROOM_QUIZ(gameId, prevQuiz));
      await this.redis.del(REDIS_KEY.ROOM_QUIZ_CHOICES(gameId, prevQuiz));
    }
    await this.redis.del(REDIS_KEY.ROOM_QUIZ_SET(gameId));

    // 퀴즈셋 랜덤 선택
    const shuffledQuizList = quizset.quizList.sort(() => 0.5 - Math.random());
    const selectedQuizList = shuffledQuizList.slice(0, parseInt(room.quizCount));

    // 퀴즈들 id 레디스에 등록
    await this.redis.sadd(
      REDIS_KEY.ROOM_QUIZ_SET(gameId),
      ...selectedQuizList.map((quiz) => quiz.id)
    );
    for (const quiz of selectedQuizList) {
      await this.redis.hset(REDIS_KEY.ROOM_QUIZ(gameId, quiz.id), {
        quiz: quiz.quiz,
        answer: quiz.choiceList.find((choice) => choice.isAnswer).order,
        limitTime: quiz.limitTime.toString(),
        choiceCount: quiz.choiceList.length.toString()
      });
      await this.redis.hset(
        REDIS_KEY.ROOM_QUIZ_CHOICES(gameId, quiz.id),
        quiz.choiceList.reduce(
          (acc, choice) => {
            acc[choice.order] = choice.content;
            return acc;
          },
          {} as Record<number, string>
        )
      );
    }

    // 리더보드 초기화
    const leaderboard = await this.redis.zrange(REDIS_KEY.ROOM_LEADERBOARD(gameId), 0, -1);
    for (const playerId of leaderboard) {
      await this.redis.zadd(REDIS_KEY.ROOM_LEADERBOARD(gameId), 0, playerId);
    }

    // 게임이 시작되었음을 알림
    await this.redis.hset(roomKey, { status: 'playing' });
    await this.redis.publish(`roomState:${gameId}`, JSON.stringify({ type: 'Start' }));

    // 첫 퀴즈 걸어주기
    await this.redis.set(REDIS_KEY.ROOM_CURRENT_QUIZ(gameId), '-1:end'); // 0:start, 0:end, 1:start, 1:end
    await this.redis.set(REDIS_KEY.ROOM_TIMER(gameId), 'timer', 'EX', 3);

    this.logger.verbose(`게임 시작 (gameId: ${gameId}) (gameMode: ${room.gameMode})`);
  }

  async setPlayerName(setPlayerNameDto: SetPlayerNameDto, clientId: string) {
    const { playerName } = setPlayerNameDto;
    const gameId = await this.redis.hget(REDIS_KEY.PLAYER(clientId), 'gameId');

    await this.redis.hmset(REDIS_KEY.PLAYER(clientId), { playerName });
    this.positionBroadcastService.updatePlayerName(clientId, playerName);
    await this.redis.publish(
      `playerState:${gameId}`,
      JSON.stringify({ type: 'Name', playerId: clientId, playerName, gameId })
    );
  }

  async subscribeRedisEvent(server: Namespace) {
    await this.redisSubscriberService.initializeSubscribers(server);
  }

  async connection(client: Socket) {
    client.data.playerId = client.handshake.headers['player-id'];

    let gameId = client.handshake.query['game-id'] as string;
    const createRoomData = parseHeaderToObject(client.handshake.query['create-room'] as string);
    if (createRoomData) {
      gameId = await this.gameRoomService.createRoom(
        {
          title: createRoomData.title as string,
          gameMode: createRoomData.gameMode as string,
          maxPlayerCount: createRoomData.maxPlayerCount as number,
          isPublic: createRoomData.isPublic as boolean
        },
        client.data.playerId
      );
      client.emit(SocketEvents.CREATE_ROOM, { gameId });
    }

    await this.gameRoomService.joinRoom(client, gameId, client.data.playerId);
  }
}
