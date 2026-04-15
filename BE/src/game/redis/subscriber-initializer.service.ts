import { Injectable, Logger } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { ScoringSubscriber } from './subscribers/scoring.subscriber';
import { RedisSubscriber } from './subscribers/base.subscriber';
import { QuizStateMachineSubscriber } from './subscribers/quiz-state-machine.subscriber';
import { RoomStateSubscriber } from './subscribers/room-state.subscriber';
import { PlayerStateSubscriber } from './subscribers/player-state.subscriber';
import { Namespace } from 'socket.io';
import { RoomCleanupSubscriber } from './subscribers/room-cleanup.subscriber';

@Injectable()
export class SubscriberInitializerService {
  private readonly logger = new Logger(SubscriberInitializerService.name);
  private readonly subscribers: RedisSubscriber[] = [];

  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly scoringSubscriber: ScoringSubscriber,
    private readonly quizStateMachineSubscriber: QuizStateMachineSubscriber,
    private readonly roomStateSubscriber: RoomStateSubscriber,
    private readonly playerStateSubscriber: PlayerStateSubscriber,
    private readonly roomCleanupSubscriber: RoomCleanupSubscriber
  ) {
    this.subscribers = [
      scoringSubscriber,
      quizStateMachineSubscriber,
      roomStateSubscriber,
      playerStateSubscriber,
      roomCleanupSubscriber
    ];
  }

  async initializeSubscribers(server: Namespace) {
    // Redis Keyspace Notification 설정 (Timer 만료 이벤트용)
    await this.redis.config('SET', 'notify-keyspace-events', 'KEhx');

    // 각 Subscriber 초기화
    for (const subscriber of this.subscribers) {
      await subscriber.subscribe(server);
      this.logger.verbose(`Initialized ${subscriber.constructor.name}`);
    }
  }
}
