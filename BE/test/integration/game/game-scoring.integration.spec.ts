import socketEvents from '../../../src/common/constants/socket-events';
import { REDIS_KEY } from '../../../src/common/constants/redis-key.constant';
import { SocketTestHelper } from '../setup/socket.helper';
import { setupTestingModule } from '../setup/game.setup';

/**
 * positionX/positionY 값에 따라 calculateAnswer가 반환하는 답 번호 (4지선다 기준)
 *   answer 1: positionX=0.1, positionY=0.1
 *   answer 2: positionX=0.1, positionY=0.9
 *   answer 3: positionX=0.9, positionY=0.1
 *   answer 4: positionX=0.9, positionY=0.9
 */
const POSITION_FOR_ANSWER: Record<number, { positionX: string; positionY: string }> = {
  1: { positionX: '0.1', positionY: '0.1' },
  2: { positionX: '0.1', positionY: '0.9' },
  3: { positionX: '0.9', positionY: '0.1' },
  4: { positionX: '0.9', positionY: '0.9' }
};

/** answer 가 아닌 다른 번호의 위치 반환 */
function wrongPositionFor(answer: number) {
  return POSITION_FOR_ANSWER[answer === 4 ? 1 : 4];
}

function waitForEvent(socket: any, eventName: string, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timeout(${timeoutMs}ms) waiting for event: ${eventName}`)),
      timeoutMs
    );
    socket.once(eventName, (data: any) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

describe('Game 스코어링 통합테스트', () => {
  let app: any;
  let redisMock: any;
  let socketHelper: SocketTestHelper;
  let port: number;
  let gameId: string;
  let client1Id: string, client2Id: string, client3Id: string;
  let client1: any, client2: any, client3: any;

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
    const entries = Array.from(result.clients.entries()) as [string, any][];
    [client1Id, client1] = entries[0];
    [client2Id, client2] = entries[1];
    [client3Id, client3] = entries[2];
  });

  afterEach(async () => {
    await socketHelper.disconnectAll();
    await redisMock.flushall();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  /** 호스트 클라이언트로 게임 시작 */
  async function startGame() {
    const started = waitForEvent(client1, socketEvents.START_GAME);
    client1.emit(socketEvents.START_GAME, { gameId });
    await started;
  }

  /**
   * Room:{gameId}:Timer 키의 expired keyspace 이벤트를 수동으로 발행한다.
   * ioredis-mock 은 TTL 만료를 실제로 처리하지 않으므로 테스트에서 직접 시뮬레이션한다.
   */
  async function publishTimerExpiry() {
    await redisMock.publish(`__keyspace@0__:Room:${gameId}:Timer`, 'expired');
  }

  /** 게임 시작 후 첫 번째 START_QUIZ_TIME 이벤트까지 대기 */
  async function startGameAndWaitForFirstQuiz(): Promise<any> {
    const quizStarted = waitForEvent(client1, socketEvents.START_QUIZ_TIME);
    await startGame();
    await publishTimerExpiry(); // -1:end → handleNextQuiz(0) → START_QUIZ_TIME
    return quizStarted;
  }

  /** 현재 퀴즈(0:start 상태)의 정답 번호를 Redis에서 읽는다 */
  async function getCurrentQuizAnswer(): Promise<number> {
    const currentQuiz = await redisMock.get(REDIS_KEY.ROOM_CURRENT_QUIZ(gameId));
    const [quizNumStr] = currentQuiz.split(':');
    const quizList: string[] = await redisMock.smembers(REDIS_KEY.ROOM_QUIZ_SET(gameId));
    const quizId = quizList[parseInt(quizNumStr)];
    const answer = await redisMock.hget(REDIS_KEY.ROOM_QUIZ(gameId, quizId), 'answer');
    return parseInt(answer);
  }

  // ─────────────────────────────────────────────────────────────
  // RANKING 모드
  // ─────────────────────────────────────────────────────────────
  describe('RANKING 모드 채점', () => {
    it('정답자가 없어도 게임이 정상 진행되고 모든 점수가 0으로 유지된다', async () => {
      await startGameAndWaitForFirstQuiz();

      const answer = await getCurrentQuizAnswer();
      const wrongPos = wrongPositionFor(answer);

      // 전원 오답 위치
      for (const id of [client1Id, client2Id, client3Id]) {
        await redisMock.hset(REDIS_KEY.PLAYER(id), wrongPos);
      }

      const endQuizPromise = waitForEvent(client1, socketEvents.END_QUIZ_TIME);
      await publishTimerExpiry(); // 0:start → handleQuizScoring → END_QUIZ_TIME
      const data = await endQuizPromise;

      expect(data.players).toBeDefined();
      for (const player of data.players) {
        expect(Number.isFinite(player.score)).toBe(true);
        expect(player.score).toBe(0);
      }
    });

    it('전원 정답이면 1000/N 점수가 각 플레이어에게 부여된다', async () => {
      await startGameAndWaitForFirstQuiz();

      const answer = await getCurrentQuizAnswer();
      const correctPos = POSITION_FOR_ANSWER[answer];

      // 전원 정답 위치
      for (const id of [client1Id, client2Id, client3Id]) {
        await redisMock.hset(REDIS_KEY.PLAYER(id), correctPos);
      }

      const endQuizPromise = waitForEvent(client1, socketEvents.END_QUIZ_TIME);
      await publishTimerExpiry();
      const data = await endQuizPromise;

      expect(data.players).toBeDefined();
      // 3명 정답 → 1000/3 ≈ 333.33, getQuizResults가 parseInt로 정수화하므로 333
      for (const player of data.players) {
        expect(player.score).toBe(Math.floor(1000 / 3));
      }
    });

    it('일부만 정답이면 정답자만 점수를 받는다', async () => {
      await startGameAndWaitForFirstQuiz();

      const answer = await getCurrentQuizAnswer();
      const correctPos = POSITION_FOR_ANSWER[answer];
      const wrongPos = wrongPositionFor(answer);

      // client1만 정답
      await redisMock.hset(REDIS_KEY.PLAYER(client1Id), correctPos);
      await redisMock.hset(REDIS_KEY.PLAYER(client2Id), wrongPos);
      await redisMock.hset(REDIS_KEY.PLAYER(client3Id), wrongPos);

      const endQuizPromise = waitForEvent(client1, socketEvents.END_QUIZ_TIME);
      await publishTimerExpiry();
      const data = await endQuizPromise;

      const p1 = data.players.find((p: any) => p.playerId === client1Id);
      const p2 = data.players.find((p: any) => p.playerId === client2Id);
      const p3 = data.players.find((p: any) => p.playerId === client3Id);

      expect(p1.score).toBe(1000); // 1명 정답 → 1000점
      expect(p2.score).toBe(0);
      expect(p3.score).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // SURVIVAL 모드
  // ─────────────────────────────────────────────────────────────
  describe('SURVIVAL 모드 채점', () => {
    beforeEach(async () => {
      // 방의 게임 모드를 SURVIVAL로 덮어쓴다
      await redisMock.hset(REDIS_KEY.ROOM(gameId), { gameMode: 'SURVIVAL' });
    });

    it('오답 플레이어는 채점 완료 후 isAlive가 0이 되어야 한다', async () => {
      await startGameAndWaitForFirstQuiz();

      const answer = await getCurrentQuizAnswer();
      const correctPos = POSITION_FOR_ANSWER[answer];
      const wrongPos = wrongPositionFor(answer);

      // client1 정답, client2·3 오답
      await redisMock.hset(REDIS_KEY.PLAYER(client1Id), correctPos);
      await redisMock.hset(REDIS_KEY.PLAYER(client2Id), wrongPos);
      await redisMock.hset(REDIS_KEY.PLAYER(client3Id), wrongPos);

      const endQuizPromise = waitForEvent(client1, socketEvents.END_QUIZ_TIME);
      await publishTimerExpiry();
      await endQuizPromise;

      const [p1, p2, p3] = await Promise.all([
        redisMock.hgetall(REDIS_KEY.PLAYER(client1Id)),
        redisMock.hgetall(REDIS_KEY.PLAYER(client2Id)),
        redisMock.hgetall(REDIS_KEY.PLAYER(client3Id))
      ]);

      expect(p1.isAlive).toBe('1'); // 정답자 생존
      expect(p2.isAlive).toBe('0'); // 오답자 탈락
      expect(p3.isAlive).toBe('0'); // 오답자 탈락
    });

    it('생존자가 1명이 되면 게임이 종료되고 모든 플레이어가 alive로 복원된다', async () => {
      await startGameAndWaitForFirstQuiz();

      const answer = await getCurrentQuizAnswer();
      const correctPos = POSITION_FOR_ANSWER[answer];
      const wrongPos = wrongPositionFor(answer);

      // client1만 정답 → aliveCount=1 ≤ 1 → 게임 종료 조건
      await redisMock.hset(REDIS_KEY.PLAYER(client1Id), correctPos);
      await redisMock.hset(REDIS_KEY.PLAYER(client2Id), wrongPos);
      await redisMock.hset(REDIS_KEY.PLAYER(client3Id), wrongPos);

      // 채점 단계: START_QUIZ_TIME(0:start) 타이머 만료 → END_QUIZ_TIME
      const endQuizPromise = waitForEvent(client1, socketEvents.END_QUIZ_TIME);
      await publishTimerExpiry();
      await endQuizPromise;

      // 다음 단계: END_QUIZ_TIME 이후 타이머 만료 → handleNextQuiz(0) → aliveCount=1 → END_GAME
      const endGamePromise = waitForEvent(client1, socketEvents.END_GAME);
      await publishTimerExpiry();
      await endGamePromise;

      // 게임 종료 후 모든 플레이어 alive 복원 검증
      const [p1, p2, p3] = await Promise.all([
        redisMock.hgetall(REDIS_KEY.PLAYER(client1Id)),
        redisMock.hgetall(REDIS_KEY.PLAYER(client2Id)),
        redisMock.hgetall(REDIS_KEY.PLAYER(client3Id))
      ]);

      expect(p1.isAlive).toBe('1');
      expect(p2.isAlive).toBe('1');
      expect(p3.isAlive).toBe('1');
    });
  });
});
