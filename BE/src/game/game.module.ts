import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GameGateway } from './game.gateway';
import { GameService } from './service/game.service';
import { RedisModule } from '@nestjs-modules/ioredis';
import { GameValidator } from './validations/game.validator';
import { GameChatService } from './service/game.chat.service';
import { GameRoomService } from './service/game.room.service';
import { QuizCacheService } from './service/quiz.cache.service';
import { QuizSetModule } from '../quiz-set/quiz-set.module';
import { QuizSetService } from '../quiz-set/service/quiz-set.service';
import { RedisSubscriberService } from './redis/redis-subscriber.service';
import { ScoringSubscriber } from './redis/subscribers/scoring.subscriber';
import { TimerSubscriber } from './redis/subscribers/timer.subscriber';
import { RoomSubscriber } from './redis/subscribers/room.subscriber';
import { PlayerSubscriber } from './redis/subscribers/player.subscriber';
import { RoomCleanupSubscriber } from './redis/subscribers/room.cleanup.subscriber';
import { JwtModule } from '@nestjs/jwt';
import { AuthModule } from '../auth/auth.module';
import { SocketEventLoggerInterceptor } from '../common/interceptor/SocketEventLoggerInterceptor';
import { SystemMetricsService } from '../common/service/SystemMetricsService';
import { PositionBroadcastService } from './service/position-broadcast.service';
import { ChatMessageModel } from './entities/chat-message.entity';

@Module({
  imports: [RedisModule, QuizSetModule, JwtModule, AuthModule, TypeOrmModule.forFeature([ChatMessageModel])],
  providers: [
    GameGateway,
    GameService,
    GameChatService,
    GameRoomService,
    GameValidator,
    QuizSetService,
    QuizCacheService,
    RedisSubscriberService,
    ScoringSubscriber,
    TimerSubscriber,
    RoomSubscriber,
    PlayerSubscriber,
    RoomCleanupSubscriber,
    SocketEventLoggerInterceptor,
    SystemMetricsService,
    PositionBroadcastService
  ],
  exports: [GameService]
})
export class GameModule {}
