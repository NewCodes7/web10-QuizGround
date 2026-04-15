import { Injectable, Logger } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { REDIS_KEY } from '../../common/constants/redis-key.constant';
import { Cron, CronExpression } from '@nestjs/schedule';

@Injectable()
export class InactiveRoomScheduler {
  private readonly logger = new Logger(InactiveRoomScheduler.name);
  private readonly BATCH_SIZE = 100; // 한 번에 처리할 배치 크기
  private readonly INACTIVE_THRESHOLD = 30 * 60 * 1000; // 30분 30 * 60 * 1000;

  private readonly TTL = {
    ROOM: 3 * 60 * 60,
    PLAYER: 2 * 60 * 60,
    QUIZ: 1 * 60 * 60,
    LEADERBOARD: 3 * 60 * 60
  };

  constructor(@InjectRedis() private readonly redis: Redis) {}

  /**
   * 비활성 방 체크 (주기적으로 실행)
   */
  /**
   * 비활성 방을 체크하고 정리하는 크론 작업
   * SCAN을 사용하여 대규모 방 목록도 안전하게 처리
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async checkInactiveRooms(): Promise<void> {
    this.logger.verbose('비활성 방 체크 시작');
    try {
      const now = Date.now();
      let cursor = '0';
      let processedCount = 0;

      do {
        // SCAN을 사용하여 배치 단위로 처리
        const [nextCursor, rooms] = await this.redis.sscan(
          REDIS_KEY.ACTIVE_ROOMS,
          cursor,
          'COUNT',
          this.BATCH_SIZE
        );
        cursor = nextCursor;

        // 병렬로 방 상태 체크 및 처리
        await Promise.all(
          rooms.map(async (roomId) => {
            try {
              const lastActivity = await this.redis.hget(REDIS_KEY.ROOM(roomId), 'lastActivityAt');

              if (lastActivity && now - parseInt(lastActivity) > this.INACTIVE_THRESHOLD) {
                await this.redis.publish('room:cleanup', roomId);
                this.logger.verbose(`비활성으로 인해 방 ${roomId} 정리 시작`);
                processedCount++;
              }
            } catch (error) {
              this.logger.error(`방 ${roomId} 처리 중 오류 발생: ${error.message}`);
            }
          })
        );
      } while (cursor !== '0');

      this.logger.verbose(`비활성 방 체크 완료: ${processedCount}개 방 정리됨`);
    } catch (error) {
      this.logger.error(`비활성 방 체크 중 오류 발생: ${error.message}`);
    }
  }

  /**
   * TTL 관리를 위한 스케줄러
   * 배치 처리로 블로킹 최소화
   */

  // @Cron(CronExpression.EVERY_MINUTE)
  async manageTTL(): Promise<void> {
    try {
      // SCAN으로 활성 방 목록을 배치로 처리
      let cursor = '0';
      do {
        const [nextCursor, rooms] = await this.redis.scan(
          cursor,
          'MATCH',
          'Room:*',
          'COUNT',
          this.BATCH_SIZE
        );
        cursor = nextCursor;

        if (rooms.length > 0) {
          await this.processBatch(rooms);
        }
      } while (cursor !== '0');

      this.logger.verbose('TTL 관리 완료');
    } catch (error) {
      this.logger.error('TTL 관리 실패', error?.message);
    }
  }

  /**
   * 배치 단위로 TTL 설정
   * Pipeline 사용으로 네트워크 요청 최소화
   */
  private async processBatch(rooms: string[]): Promise<void> {
    const pipeline = this.redis.pipeline();

    for (const roomKey of rooms) {
      const roomId = roomKey.split(':')[1];
      if (!roomId) {
        continue;
      }

      // 방 관련 기본 키들
      const baseKeys = [
        REDIS_KEY.ROOM(roomId),
        REDIS_KEY.ROOM_PLAYERS(roomId),
        REDIS_KEY.ROOM_LEADERBOARD(roomId),
        REDIS_KEY.ROOM_CURRENT_QUIZ(roomId)
      ];

      // TTL 설정을 파이프라인에 추가
      for (const key of baseKeys) {
        pipeline.expire(key, this.TTL.ROOM);
      }
    }

    // 파이프라인 실행
    await pipeline.exec();
  }

  /**
   * 플레이어 TTL 설정
   * 비동기로 처리하되 에러는 로깅
   */
  private async setPlayersTTL(roomId: string): Promise<void> {
    try {
      const pipeline = this.redis.pipeline();
      const players = await this.redis.smembers(REDIS_KEY.ROOM_PLAYERS(roomId));

      for (const playerId of players) {
        pipeline.expire(REDIS_KEY.PLAYER(playerId), this.TTL.PLAYER);
      }

      await pipeline.exec();
    } catch (error) {
      this.logger.error(`플레이어 TTL 설정 실패 - Room: ${roomId}`, error?.message);
    }
  }

  /**
   * 퀴즈 TTL 설정
   * 비동기로 처리하되 에러는 로깅
   */
  private async setQuizTTL(roomId: string): Promise<void> {
    try {
      const pipeline = this.redis.pipeline();
      const quizList = await this.redis.smembers(REDIS_KEY.ROOM_QUIZ_SET(roomId));

      for (const quizId of quizList) {
        pipeline.expire(REDIS_KEY.ROOM_QUIZ(roomId, quizId), this.TTL.QUIZ);
        pipeline.expire(REDIS_KEY.ROOM_QUIZ_CHOICES(roomId, quizId), this.TTL.QUIZ);
      }

      await pipeline.exec();
    } catch (error) {
      this.logger.error(`퀴즈 TTL 설정 실패 - Room: ${roomId}`, error?.message);
    }
  }

  /**
   * 단일 방에 대한 모든 TTL 설정
   * 비동기 처리로 블로킹 최소화
   */
  public async setRoomTTL(roomId: string): Promise<void> {
    // 비동기로 각 작업 실행
    await Promise.allSettled([
      this.processBatch([REDIS_KEY.ROOM(roomId)]),
      this.setPlayersTTL(roomId),
      this.setQuizTTL(roomId)
    ]);
  }
}
