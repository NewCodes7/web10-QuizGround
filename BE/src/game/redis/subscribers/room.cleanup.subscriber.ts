import { Injectable } from '@nestjs/common';
import { RedisSubscriber } from './base.subscriber';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { Namespace } from 'socket.io';
import { REDIS_KEY } from '../../../common/constants/redis-key.constant';

@Injectable()
export class RoomCleanupSubscriber extends RedisSubscriber {
  constructor(@InjectRedis() redis: Redis) {
    super(redis);
  }

  /**
   * Redis 구독 초기화 및 정리 이벤트 핸들러 등록
   */
  async subscribe(server: Namespace): Promise<void> {
    const subscriber = this.redis.duplicate();

    // 방 정리 이벤트 구독
    await subscriber.subscribe('room:cleanup');

    // 일반 메시지 리스너
    subscriber.on('message', async (channel, roomId) => {
      if (channel === 'room:cleanup') {
        await this.cleanupRoom(roomId);
      }
    });

    this.logger.verbose('방 정리 이벤트 구독 시작');
  }

  /**
   * 방 및 관련 데이터 정리
   */
  private async cleanupRoom(roomId: string): Promise<void> {
    try {
      const pipeline = this.redis.pipeline();

      // 1. 방에 속한 플레이어 목록 가져오기, 200명미만 -> smembers 사용!
      const players = await this.redis.smembers(REDIS_KEY.ROOM_PLAYERS(roomId));

      // 2. 플레이어 데이터 삭제
      for (const playerId of players) {
        pipeline.del(REDIS_KEY.PLAYER(playerId));
      }

      // 1. 방 관련 기본 데이터 삭제
      pipeline.del(REDIS_KEY.ROOM(roomId));
      pipeline.del(REDIS_KEY.ROOM_PLAYERS(roomId));
      pipeline.del(REDIS_KEY.ROOM_LEADERBOARD(roomId));
      pipeline.del(REDIS_KEY.ROOM_CURRENT_QUIZ(roomId));
      pipeline.del(REDIS_KEY.ROOM_TIMER(roomId));

      // 2. 퀴즈 데이터 정리
      const quizList = await this.redis.smembers(REDIS_KEY.ROOM_QUIZ_SET(roomId));
      for (const quizId of quizList) {
        pipeline.del(REDIS_KEY.ROOM_QUIZ(roomId, quizId));
        pipeline.del(REDIS_KEY.ROOM_QUIZ_CHOICES(roomId, quizId));
      }
      pipeline.del(REDIS_KEY.ROOM_QUIZ_SET(roomId));

      // 3. 활성 방 목록에서 제거
      pipeline.srem(REDIS_KEY.ACTIVE_ROOMS, roomId);

      await pipeline.exec(); // 네트워크에 한번에 요청보내기
      this.logger.verbose(`방 ${roomId} 정리 완료`);
    } catch (error) {
      this.logger.error(`방 ${roomId} 정리 실패`, error?.message);
    }
  }
}
