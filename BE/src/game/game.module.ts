import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GameGateway } from './game.gateway';
import { GameSessionService } from './service/game-session.service';
import { RedisModule } from '@nestjs-modules/ioredis';
import { GameValidator } from './middleware/game.validator';
import { GameChatService } from './service/game-chat.service';
import { GameRoomService } from './service/game-room.service';
import { QuizCacheService } from './service/quiz-cache.service';
import { QuizSetModule } from '../quiz-set/quiz-set.module';
import { QuizSetService } from '../quiz-set/service/quiz-set.service';
import { SubscriberInitializerService } from './redis/subscriber-initializer.service';
import { ScoringSubscriber } from './redis/subscribers/scoring.subscriber';
import { QuizStateMachineSubscriber } from './redis/subscribers/quiz-state-machine.subscriber';
import { RoomStateSubscriber } from './redis/subscribers/room-state.subscriber';
import { PlayerStateSubscriber } from './redis/subscribers/player-state.subscriber';
import { RoomCleanupSubscriber } from './redis/subscribers/room-cleanup.subscriber';
import { JwtModule } from '@nestjs/jwt';
import { AuthModule } from '../auth/auth.module';
import { SocketEventLoggerInterceptor } from '../common/interceptor/SocketEventLoggerInterceptor';
import { SystemMetricsService } from '../common/service/SystemMetricsService';
import { PositionBroadcastService } from './service/position-broadcast.service';
import { ChatMessageModel } from './entities/chat-message.entity';

@Module({
  imports: [
    RedisModule,
    QuizSetModule,
    JwtModule,
    AuthModule,
    TypeOrmModule.forFeature([ChatMessageModel])
  ],
  providers: [
    GameGateway,
    GameSessionService,
    GameChatService,
    GameRoomService,
    GameValidator,
    QuizSetService,
    QuizCacheService,
    SubscriberInitializerService,
    ScoringSubscriber,
    QuizStateMachineSubscriber,
    RoomStateSubscriber,
    PlayerStateSubscriber,
    RoomCleanupSubscriber,
    SocketEventLoggerInterceptor,
    SystemMetricsService,
    PositionBroadcastService
  ],
  exports: [GameSessionService]
})
export class GameModule {}
