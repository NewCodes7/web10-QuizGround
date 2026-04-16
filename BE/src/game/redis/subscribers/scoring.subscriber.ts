import { Injectable } from '@nestjs/common';
import { RedisSubscriber } from './base.subscriber';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { Namespace } from 'socket.io';
import { REDIS_KEY } from '../../../common/constants/redis-key.constant';
import SocketEvents from '../../../common/constants/socket-events';

@Injectable()
export class ScoringSubscriber extends RedisSubscriber {
  constructor(@InjectRedis() redis: Redis) {
    super(redis);
  }

  async subscribe(server: Namespace): Promise<void> {
    const subscriber = this.redis.duplicate();
    await subscriber.psubscribe('scoring:*');

    subscriber.on('pmessage', async (_pattern, channel, message) => {
      const gameId = channel.split(':')[1];
      await this.handleScoring(gameId, parseInt(message), server);
    });
  }

  private async handleScoring(gameId: string, completeClientsCount: number, server: Namespace) {
    const scoringKey = REDIS_KEY.ROOM_SCORING_COUNT(gameId);

    // NX: 키가 없을 때만 0으로 초기화 (원자적), 이후 increment도 await로 직렬화
    await this.redis.set(scoringKey, '0', 'NX');
    const newCount = await this.redis.incrby(scoringKey, completeClientsCount);
    const playersCount = await this.redis.scard(REDIS_KEY.ROOM_PLAYERS(gameId));

    if (newCount >= playersCount) {
      await this.completeScoring(gameId, server);
      await this.redis.set(scoringKey, '0');
    }
  }

  private async completeScoring(gameId: string, server: Namespace) {
    const { quiz, players } = await this.getQuizResults(gameId);

    server.to(gameId).emit(SocketEvents.END_QUIZ_TIME, {
      answer: quiz.answer,
      players
    });

    await this.updateQuizState(gameId, quiz.quizNum);
    this.logger.verbose(`[endQuizTime] RoomId: ${gameId} | quizNum: ${quiz.quizNum}`);
  }

  private async updateQuizState(gameId: string, quizNum: number) {
    await this.redis.set(REDIS_KEY.ROOM_CURRENT_QUIZ(gameId), `${quizNum}:end`); // timer.subscriber.ts 구독 핸들러 실행
    await this.redis.set(REDIS_KEY.ROOM_TIMER(gameId), 'timer', 'EX', '10', 'NX');
  }
}
