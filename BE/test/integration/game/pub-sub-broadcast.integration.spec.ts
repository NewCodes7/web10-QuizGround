import { io } from 'socket.io-client';
import * as msgpackParser from 'socket.io-msgpack-parser';
import socketEvents from '../../../src/common/constants/socket-events';
import { SocketTestHelper } from '../setup/socket.helper';
import { setupTestingModule } from '../setup/game.setup';

/**
 * Changes 마커 + Keyspace Notification → 직접 pub/sub 전환 후
 * roomState:{gameId} / playerState:{gameId} 채널을 통한 브로드캐스트 검증
 *
 * 검증 기준: 이벤트를 emit한 클라이언트가 아닌 다른 클라이언트가 이벤트를 수신하는지 확인
 */
describe('pub/sub 브로드캐스트 통합테스트', () => {
  let app;
  let redisMock;
  let socketHelper: SocketTestHelper;
  let client1Id, client2Id;
  let client1, client2;
  let port;
  let gameId;

  // 이벤트 수신 대기 헬퍼 (지정 시간 내 미수신 시 reject)
  const waitForEvent = <T>(socket: any, event: string, timeoutMs = 2000): Promise<T> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`'${event}' 이벤트 수신 타임아웃`)),
        timeoutMs
      );
      socket.once(event, (data: T) => {
        clearTimeout(timer);
        resolve(data);
      });
    });

  beforeAll(async () => {
    const setup = await setupTestingModule();
    app = setup.app;
    redisMock = setup.redisMock;
    port = setup.port;
    socketHelper = new SocketTestHelper();
  });

  beforeEach(async () => {
    await redisMock.flushall();
    const result = await socketHelper.connectClients(port, 2);
    gameId = result.gameId;
    const clientsEntries = Array.from(result.clients.entries());
    [client1Id, client1] = clientsEntries[0]; // 호스트
    [client2Id, client2] = clientsEntries[1];
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

  // ────────────────────────────────────────────────────────────
  // playerState pub/sub
  // ────────────────────────────────────────────────────────────

  describe('playerState pub/sub', () => {
    it('새 플레이어 입장 시 기존 플레이어에게 JOIN_ROOM 브로드캐스트', async () => {
      const joinPromise = waitForEvent<any>(client1, socketEvents.JOIN_ROOM);

      const newClient = io(`http://localhost:${port}/game`, {
        transports: ['websocket'],
        forceNew: true,
        parser: msgpackParser,
        query: { 'game-id': gameId }
      });

      const data = await joinPromise;
      newClient.disconnect();

      expect(data.players).toHaveLength(1);
      expect(data.players[0].playerId).toBeDefined();
      expect(data.players[0].playerPosition).toHaveLength(2);
      expect(data.players[0].isHost).toBe(false);
    });

    it('플레이어 퇴장 시 방 전체에 EXIT_ROOM 브로드캐스트', async () => {
      const exitPromise = waitForEvent<any>(client1, socketEvents.EXIT_ROOM);

      client2.disconnect();

      const data = await exitPromise;
      expect(data.playerId).toBe(client2Id);
    });

    it('플레이어 이름 설정 시 방 전체에 SET_PLAYER_NAME 브로드캐스트', async () => {
      const namePromise = waitForEvent<any>(client2, socketEvents.SET_PLAYER_NAME);

      client1.emit(socketEvents.SET_PLAYER_NAME, { playerName: '테스트플레이어' });

      const data = await namePromise;
      expect(data.playerId).toBe(client1Id);
      expect(data.playerName).toBe('테스트플레이어');
    });

    it('강퇴 시 방 전체에 KICK_ROOM 브로드캐스트', async () => {
      const kickPromise = waitForEvent<any>(client2, socketEvents.KICK_ROOM);

      client1.emit(socketEvents.KICK_ROOM, { gameId, kickPlayerId: client2Id });

      const data = await kickPromise;
      expect(data.playerId).toBe(client2Id);
    });

    it('강퇴 시 EXIT_ROOM도 함께 브로드캐스트', async () => {
      // KICK_ROOM 다음에 EXIT_ROOM이 연속으로 emit됨
      const kickPromise = waitForEvent<any>(client2, socketEvents.KICK_ROOM);
      const exitPromise = waitForEvent<any>(client2, socketEvents.EXIT_ROOM);

      client1.emit(socketEvents.KICK_ROOM, { gameId, kickPlayerId: client2Id });

      const [kickData, exitData] = await Promise.all([kickPromise, exitPromise]);
      expect(kickData.playerId).toBe(client2Id);
      expect(exitData.playerId).toBe(client2Id);
    });
  });

  // ────────────────────────────────────────────────────────────
  // roomState pub/sub
  // ────────────────────────────────────────────────────────────

  describe('roomState pub/sub', () => {
    it('방 옵션 변경 시 방 전체에 UPDATE_ROOM_OPTION 브로드캐스트', async () => {
      const optionPromise = waitForEvent<any>(client2, socketEvents.UPDATE_ROOM_OPTION);

      client1.emit(socketEvents.UPDATE_ROOM_OPTION, {
        gameId,
        title: '변경된 방 제목',
        gameMode: 'SURVIVAL',
        maxPlayerCount: 10,
        isPublic: false
      });

      const data = await optionPromise;
      expect(data.title).toBe('변경된 방 제목');
      expect(data.gameMode).toBe('SURVIVAL');
      expect(data.maxPlayerCount).toBe(10);
      expect(data.isPublic).toBe(false);
    });

    it('퀴즈셋 변경 시 방 전체에 UPDATE_ROOM_QUIZSET 브로드캐스트', async () => {
      const quizsetPromise = waitForEvent<any>(client2, socketEvents.UPDATE_ROOM_QUIZSET);

      client1.emit(socketEvents.UPDATE_ROOM_QUIZSET, {
        gameId,
        quizSetId: 42,
        quizCount: 5
      });

      const data = await quizsetPromise;
      expect(Number(data.quizSetId)).toBe(42);
      expect(Number(data.quizCount)).toBe(5);
    });

    it('게임 시작 시 방 전체에 START_GAME 브로드캐스트', async () => {
      const startPromise = waitForEvent<any>(client2, socketEvents.START_GAME);

      client1.emit(socketEvents.START_GAME, { gameId });

      await expect(startPromise).resolves.toBeDefined();
    });

    it('호스트 퇴장 시 방 전체에 UPDATE_HOST 브로드캐스트', async () => {
      const hostPromise = waitForEvent<any>(client2, socketEvents.UPDATE_HOST);

      client1.disconnect();

      const data = await hostPromise;
      // 남은 플레이어 중 한 명이 새 호스트가 되어야 함
      expect(data.hostId).toBe(client2Id);
    });

    it('방 옵션 변경이 Redis에도 반영되는지 확인', async () => {
      const optionPromise = waitForEvent<any>(client2, socketEvents.UPDATE_ROOM_OPTION);

      client1.emit(socketEvents.UPDATE_ROOM_OPTION, {
        gameId,
        title: 'Redis 반영 테스트',
        gameMode: 'RANKING',
        maxPlayerCount: 8,
        isPublic: true
      });

      await optionPromise;

      const roomData = await redisMock.hgetall(`Room:${gameId}`);
      expect(roomData.title).toBe('Redis 반영 테스트');
      expect(roomData.maxPlayerCount).toBe('8');
    });
  });
});
