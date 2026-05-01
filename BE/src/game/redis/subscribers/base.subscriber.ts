import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { Logger } from '@nestjs/common';
import { Namespace } from 'socket.io';
import { REDIS_KEY } from '../../../common/constants/redis-key.constant';

export abstract class RedisSubscriber {
  protected readonly logger: Logger;

  protected constructor(@InjectRedis() protected readonly redis: Redis) {
    this.logger = new Logger(this.constructor.name);
  }

  abstract subscribe(server: Namespace): Promise<void>;

  async getQuizResults(gameId: string) {
    // 1. 현재 퀴즈 정보 가져오기
    const currentQuiz = await this.redis.get(REDIS_KEY.ROOM_CURRENT_QUIZ(gameId));
    const [quizNum] = currentQuiz.split(':');

    // 2. 퀴즈 상세 정보 가져오기
    const quizList = await this.redis.smembers(REDIS_KEY.ROOM_QUIZ_SET(gameId));
    const quiz = (await this.redis.hgetall(
      REDIS_KEY.ROOM_QUIZ(gameId, quizList[parseInt(quizNum)])
    )) as any;

    // 3. 리더보드 정보 가져오기
    const leaderboard = await this.redis.zrange(
      REDIS_KEY.ROOM_LEADERBOARD(gameId),
      0,
      -1,
      'WITHSCORES'
    );

    // 4. 플레이어 정보 구성: 순차 hget × 200 → pipeline 1회
    const playerIds: string[] = [];
    const scores: number[] = [];
    for (let i = 0; i < leaderboard.length; i += 2) {
      playerIds.push(leaderboard[i]);
      scores.push(parseInt(leaderboard[i + 1]));
    }

    const answerPipeline = this.redis.pipeline();
    playerIds.forEach((id) => answerPipeline.hget(REDIS_KEY.PLAYER(id), 'isAnswerCorrect'));
    const answerResults = await answerPipeline.exec();

    const players = playerIds.map((playerId, i) => ({
      playerId,
      score: scores[i],
      isAnswer: (answerResults[i][1] as string) === '1'
    }));

    return {
      quiz: {
        ...quiz,
        quizNum: parseInt(quizNum)
      },
      players
    };
  }
}
