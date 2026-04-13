import socketEvents from '../../../src/common/constants/socket-events';
import { REDIS_KEY } from '../../../src/common/constants/redis-key.constant';
import { SocketTestHelper } from '../setup/socket.helper';
import { setupTestingModule } from '../setup/game.setup';

describe('Game 통합테스트', () => {
  let app;
  let redisMock;
  let socketHelper: SocketTestHelper;
  let client1Id, client2Id, client3Id;
  let client1, client2, client3;
  let port;
  let gameId;

  beforeAll(async () => {
    const setup = await setupTestingModule();
    app = setup.app;
    redisMock = setup.redisMock;
    port = setup.port;
    socketHelper = new SocketTestHelper();
  });

  beforeEach(async () => {
    await redisMock.flushall();

    const result = await socketHelper.connectClients(port, 3);
    gameId = result.gameId;
    const clientsEntries = Array.from(result.clients.entries());
    [client1Id, client1] = clientsEntries[0];
    [client2Id, client2] = clientsEntries[1];
    [client3Id, client3] = clientsEntries[2];
  });

  afterEach(async () => {
    await socketHelper.disconnectAll();
    await redisMock.flushall();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  describe('updatePosition 이벤트 테스트', () => {
    it('위치 업데이트 성공', async () => {
      // const createResponse = await createRoom(client1);
      // const joinResponse = await joinRoom(client1, createResponse.gameId);
      // const joinResponse2 = await joinRoom(client2, createResponse.gameId);
      // const joinResponse3 = await joinRoom(client3, createResponse.gameId);

      const newPosition = [0.2, 0.5];

      const updateResponse = await new Promise<any>((resolve) => {
        client1.once(socketEvents.UPDATE_POSITION, resolve);
        client1.emit(socketEvents.UPDATE_POSITION, {
          gameId: gameId,
          newPosition
        });
      });

      // 새 포맷: { seq, updates: [{ playerId, playerPosition }] }
      const update = updateResponse.updates?.[0] ?? updateResponse;
      expect(update.playerPosition).toEqual(newPosition);

      // Redis에서 위치 정보 확인
      const playerData = await redisMock.hgetall(`Player:${client1Id}`);
      expect(parseFloat(playerData.positionX)).toBe(newPosition[0]);
      expect(parseFloat(playerData.positionY)).toBe(newPosition[1]);
    });
  });

  describe('startGame 이벤트 테스트', () => {
    it('게임 시작할 때 초기 설정 성공', async () => {
      // const createResponse = await createRoom(client1);
      // const joinResponse = await joinRoom(client1, createResponse.gameId);
      // const joinResponse2 = await joinRoom(client2, createResponse.gameId);
      // const joinResponse3 = await joinRoom(client3, createResponse.gameId);

      const startGamePromise = new Promise<void>((resolve) => {
        client1.once(socketEvents.START_GAME, () => {
          console.log('START_GAME 이벤트 수신!');
          resolve(); // 이벤트 수신 시 Promise 해결
        });
      });

      client1.emit(socketEvents.START_GAME, {
        gameId: gameId
      });

      // await new Promise((resolve) => setTimeout(resolve, 100));
      await startGamePromise;

      // Redis 검증
      const quizSetIds = await redisMock.smembers(REDIS_KEY.ROOM_QUIZ_SET(gameId));
      const leaderboard = await redisMock.zrevrange(REDIS_KEY.ROOM_LEADERBOARD(gameId), 0, -1);

      const room = await redisMock.hgetall(`Room:${gameId}`);

      expect(quizSetIds.length).toBeGreaterThan(0);
      expect(leaderboard).toBeDefined();
      expect(room.quizSetTitle).toBeDefined();
    });

    // TODO: 향후 개선 필요 (우선순위가 높진 않아 현재 PASS)
    // it('캐시에 없는 퀴즈셋의 경우 DB에서 조회하고 캐시에 저장해야 한다.', async () => {
    //   // 1. 방 생성
    //   const createResponse = await new Promise<{ gameId: string }>((resolve) => {
    //     client1.once(socketEvents.CREATE_ROOM, resolve);
    //     client1.emit(socketEvents.CREATE_ROOM, {
    //       title: 'Cache Test Room',
    //       gameMode: 'RANKING',
    //       maxPlayerCount: 5,
    //       isPublic: true
    //     });
    //   });
    //   const gameId = createResponse.gameId;
    //
    //   // 퀴즈셋 ID 설정
    //   const testQuizSetId = 1;
    //   await redisMock.hset(`Room:${gameId}`, 'quizSetId', testQuizSetId.toString());
    //
    //   // 캐시 키 설정
    //   const cacheKey = REDIS_KEY.QUIZSET_ID(testQuizSetId);
    //
    //   // 초기 상태 확인 - 캐시에 데이터 없어야 함
    //   const initialCache = await redisMock.get(cacheKey);
    //   expect(initialCache).toBeNull();
    //
    //   // 플레이어 입장 (호스트 권한을 위해)
    //   await new Promise<void>((resolve) => {
    //     client1.once(socketEvents.JOIN_ROOM, () => resolve());
    //     client1.emit(socketEvents.JOIN_ROOM, {
    //       gameId: gameId,
    //       playerName: 'Player1'
    //     });
    //   });
    //
    //   //updateRoomQuizSet
    //   await new Promise<void>((resolve) => {
    //     client1.once(socketEvents.UPDATE_ROOM_QUIZSET, () => resolve());
    //     client1.emit(socketEvents.UPDATE_ROOM_QUIZSET, {
    //       gameId: gameId,
    //       quizSetId: testQuizSetId,
    //       quizCount: 1
    //     });
    //   });
    //
    //   // 5. QuizSetService mock 설정
    //   const mockQuizSet = {
    //     id: String(testQuizSetId),
    //     title: 'Test Quiz Set',
    //     category: 'Test Category',
    //     quizList: [
    //       {
    //         id: '1',
    //         quiz: 'Test Question 1',
    //         choiceList: [
    //           { order: 1, content: 'Choice 1', isAnswer: true },
    //           { order: 2, content: 'Choice 2', isAnswer: false }
    //         ],
    //         limitTime: 30
    //       }
    //     ]
    //   };
    //   const quizServiceSpy = jest
    //     .spyOn(moduleRef.get(QuizSetService), 'findOne')
    //     .mockResolvedValue(mockQuizSet);
    //
    //   // 6. 게임 시작
    //   await new Promise<void>((resolve) => {
    //     client1.once(socketEvents.START_GAME, () => resolve());
    //     client1.emit(socketEvents.START_GAME, { gameId });
    //   });
    //
    //   // Redis 업데이트 대기
    //   await new Promise((resolve) => setTimeout(resolve, 100));
    //
    //   // 7. 캐시 저장 확인
    //   const cachedData = await redisMock.get(cacheKey);
    //   expect(cachedData).not.toBeNull();
    //   expect(JSON.parse(cachedData!)).toEqual(mockQuizSet);
    //
    //   // QuizSetService.findOne이 호출되었는지
    //   expect(quizServiceSpy).toHaveBeenCalled();
    // });
    //
    // it('캐시에 있는 퀴즈셋의 경우 DB 조회 없이 캐시에서 가져와야 한다', async () => {
    //   // 1. 방 생성
    //   const createResponse = await new Promise<{ gameId: string }>((resolve) => {
    //     client1.once(socketEvents.CREATE_ROOM, resolve);
    //     client1.emit(socketEvents.CREATE_ROOM, {
    //       title: 'Cache Hit Test Room',
    //       gameMode: 'RANKING',
    //       maxPlayerCount: 5,
    //       isPublic: true
    //     });
    //   });
    //   const gameId = createResponse.gameId;
    //
    //   // 2. 퀴즈셋 ID 설정
    //   const testQuizSetId = 2;
    //   await redisMock.hset(`Room:${gameId}`, 'quizSetId', testQuizSetId.toString());
    //
    //   // 플레이어 입장 (호스트 권한을 위해)
    //   await new Promise<void>((resolve) => {
    //     client1.once(socketEvents.JOIN_ROOM, () => resolve());
    //     client1.emit(socketEvents.JOIN_ROOM, {
    //       gameId: gameId,
    //       playerName: 'Player1'
    //     });
    //   });
    //
    //   //updateRoomQuizSet
    //   await new Promise<void>((resolve) => {
    //     client1.once(socketEvents.UPDATE_ROOM_QUIZSET, () => resolve());
    //     client1.emit(socketEvents.UPDATE_ROOM_QUIZSET, {
    //       gameId: gameId,
    //       quizSetId: testQuizSetId,
    //       quizCount: 1
    //     });
    //   });
    //
    //   // 3. 미리 캐시에 데이터 저장
    //   const cachedQuizSet = {
    //     id: testQuizSetId,
    //     title: 'Cached Quiz Set',
    //     quizList: [
    //       {
    //         id: 1,
    //         quiz: 'Cached Question',
    //         choiceList: [
    //           { order: 1, content: 'Cached Choice 1', isAnswer: true },
    //           { order: 2, content: 'Cached Choice 2', isAnswer: false }
    //         ],
    //         limitTime: 30
    //       }
    //     ]
    //   };
    //   await redisMock.set(
    //     REDIS_KEY.QUIZSET_ID(testQuizSetId),
    //     JSON.stringify(cachedQuizSet),
    //     'EX',
    //     1800
    //   );
    //
    //   // 4. QuizSetService mock 설정 (호출되지 않아야 함)
    //   const quizServiceSpy = jest.spyOn(moduleRef.get(QuizSetService), 'findOne');
    //
    //   // 5. 게임 시작
    //   await new Promise<void>((resolve) => {
    //     client1.once(socketEvents.START_GAME, () => resolve());
    //     client1.emit(socketEvents.START_GAME, { gameId });
    //   });
    //
    //   // Redis 업데이트 대기
    //   await new Promise((resolve) => setTimeout(resolve, 100));
    //
    //   // 6. 검증
    //   // QuizSetService.findOne이 호출되지 않았는지 확인
    //   expect(quizServiceSpy).not.toHaveBeenCalled();
    //
    //   // Room에 설정된 title이 캐시된 데이터의 title과 일치하는지 확인
    //   const roomData = await redisMock.hgetall(`Room:${gameId}`);
    //   expect(roomData.quizSetTitle).toBe(cachedQuizSet.title);
    // });
    //
    // it('캐시가 만료되면 DB에서 다시 조회해야 한다', async () => {
    //   // 1. 방 생성
    //   const createResponse = await new Promise<{ gameId: string }>((resolve) => {
    //     client1.once(socketEvents.CREATE_ROOM, resolve);
    //     client1.emit(socketEvents.CREATE_ROOM, {
    //       title: 'Expiry Test Room',
    //       gameMode: 'RANKING',
    //       maxPlayerCount: 5,
    //       isPublic: true
    //     });
    //   });
    //   const gameId = createResponse.gameId;
    //
    //   // 2. 퀴즈셋 ID 설정
    //   const testQuizSetId = 3;
    //   await redisMock.hset(`Room:${gameId}`, 'quizSetId', testQuizSetId.toString());
    //
    //   // 플레이어 입장 (호스트 권한을 위해)
    //   await new Promise<void>((resolve) => {
    //     client1.once(socketEvents.JOIN_ROOM, () => resolve());
    //     client1.emit(socketEvents.JOIN_ROOM, {
    //       gameId: gameId,
    //       playerName: 'Player1'
    //     });
    //   });
    //
    //   //updateRoomQuizSet
    //   await new Promise<void>((resolve) => {
    //     client1.once(socketEvents.UPDATE_ROOM_QUIZSET, () => resolve());
    //     client1.emit(socketEvents.UPDATE_ROOM_QUIZSET, {
    //       gameId: gameId,
    //       quizSetId: testQuizSetId,
    //       quizCount: 1
    //     });
    //   });
    //
    //   // 3. 캐시에 데이터 저장 (1초 후 만료)
    //   const cachedQuizSet = {
    //     id: testQuizSetId,
    //     title: 'Soon to Expire Quiz Set',
    //     quizList: [
    //       {
    //         id: 1,
    //         quiz: 'Question',
    //         choiceList: [
    //           { order: 1, content: 'Choice 1', isAnswer: true },
    //           { order: 2, content: 'Choice 2', isAnswer: false }
    //         ],
    //         limitTime: 30
    //       }
    //     ]
    //   };
    //   await redisMock.set(`quizset:${testQuizSetId}`, JSON.stringify(cachedQuizSet), 'EX', 1);
    //
    //   // 4. DB에서 가져올 새로운 데이터 설정
    //   const newQuizSet = {
    //     id: '3',
    //     title: 'New Quiz Set',
    //     category: 'Test Category',
    //     quizList: [
    //       {
    //         id: '1',
    //         quiz: 'Test Question 1',
    //         choiceList: [
    //           { order: 1, content: 'Choice 1', isAnswer: true },
    //           { order: 2, content: 'Choice 2', isAnswer: false }
    //         ],
    //         limitTime: 30
    //       }
    //     ]
    //   };
    //   jest.spyOn(moduleRef.get(QuizSetService), 'findOne').mockResolvedValue(newQuizSet);
    //
    //   // 5. 캐시 만료 대기
    //   await new Promise((resolve) => setTimeout(resolve, 1100));
    //
    //   // 6. 게임 시작
    //   await new Promise<void>((resolve) => {
    //     client1.once(socketEvents.START_GAME, () => resolve());
    //     client1.emit(socketEvents.START_GAME, { gameId });
    //   });
    //
    //   // Redis 업데이트 대기
    //   await new Promise((resolve) => setTimeout(resolve, 100));
    //
    //   // 7. 검증
    //   const roomData = await redisMock.hgetall(`Room:${gameId}`);
    //   expect(roomData.quizSetTitle).toBe(newQuizSet.title);
    // });
  });
});
