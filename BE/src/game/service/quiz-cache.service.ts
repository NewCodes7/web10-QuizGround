import { QuizSetData } from '../../InitDB/InitDB.Service';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import { Redis } from 'ioredis';
import { mockQuizData } from '../../../test/mocks/quiz-data.mock';
import { REDIS_KEY } from '../../common/constants/redis-key.constant';
import { QuizSetService } from '../../quiz-set/service/quiz-set.service';
import { TraceClass } from '../../common/interceptor/SocketEventLoggerInterceptor';

@TraceClass()
@Injectable()
export class QuizCacheService {
  private readonly quizCache = new Map<string, any>();
  private readonly logger = new Logger(QuizCacheService.name);
  private readonly CACHE_TTL = 1 * 60 * 30; // 30분

  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly quizService: QuizSetService
  ) {}

  /**
   * Redis 캐시에서 퀴즈셋 조회
   */
  private async getFromRedisCache(quizSetId: number) {
    const cacheKey = REDIS_KEY.QUIZSET_ID(quizSetId);
    const cachedData = await this.redis.get(cacheKey);

    if (cachedData) {
      return JSON.parse(cachedData);
    }
    return null;
  }

  /**
   * Redis 캐시에 퀴즈셋 저장
   */
  private async setToRedisCache(quizSetId: number, data: QuizSetData): Promise<void> {
    const cacheKey = REDIS_KEY.QUIZSET_ID(quizSetId);
    await this.redis.set(cacheKey, JSON.stringify(data), 'EX', this.CACHE_TTL);
  }

  /**
   * 퀴즈셋 데이터 조회 (캐시 활용)
   */
  async getQuizSet(quizSetId: number) {
    // 1. 로컬 메모리 캐시 확인
    // const localCached = this.quizCache.get(this.getCacheKey(quizSetId));
    // if (localCached) {
    //   this.logger.debug(`Quiz ${quizSetId} found in local cache`);
    //   return localCached;
    // }

    // 2. Redis 캐시 확인
    const redisCached = await this.getFromRedisCache(quizSetId);
    if (redisCached) {
      this.logger.debug(`Quiz ${quizSetId} found in Redis cache`);
      // 로컬 캐시에도 저장
      // this.quizCache.set(REDIS_KEY.QUIZSET_ID(quizSetId), redisCached);
      return redisCached;
    }

    // 3. DB에서 조회
    const quizData = quizSetId === -1 ? mockQuizData : await this.quizService.findOne(quizSetId);

    // 4. 캐시에 저장
    await this.setToRedisCache(quizSetId, quizData);
    this.quizCache.set(REDIS_KEY.QUIZSET_ID(quizSetId), quizData);

    return quizData;
  }

  /**
   * 캐시 무효화
   */
  async invalidateCache(quizSetId: number): Promise<void> {
    const cacheKey = REDIS_KEY.QUIZSET_ID(quizSetId);
    this.quizCache.delete(cacheKey);
    await this.redis.del(cacheKey);
  }
}
