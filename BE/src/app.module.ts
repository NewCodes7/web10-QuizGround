import { join } from 'path';
import { ClassSerializerInterceptor, Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { GameModule } from './game/game.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RedisModule } from '@nestjs-modules/ioredis';
import { ConfigModule } from '@nestjs/config';
import { QuizSetModel } from './quiz-set/entities/quiz-set.entity';
import { QuizModel } from './quiz-set/entities/quiz.entity';
import { QuizChoiceModel } from './quiz-set/entities/quiz-choice.entity';
import { UserModel } from './user/entities/user.entity';
import { UserQuizArchiveModel } from './user/entities/user-quiz-archive.entity';
import { ChatMessageModel } from './game/entities/chat-message.entity';
import { InitDBModule } from './InitDB/InitDB.module';
import { UserModule } from './user/user.module';
import { QuizSetModule } from './quiz-set/quiz-set.module';
import { WaitingRoomModule } from './waiting-room/waiting-room.module';
import { TimeController } from './time/time.controller';
import { TimeModule } from './time/time.module';
import { AuthModule } from './auth/auth.module';
import { ScheduleModule } from '@nestjs/schedule';
import { InactiveRoomScheduler } from './game/redis/inactive-room.scheduler';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { MetricModule } from './metric/metric.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      envFilePath: '../.env',
      isGlobal: true
    }),
    GameModule,
    // 스케줄러 모듈 추가 (Redis 메모리 관리 서비스의 @Cron 데코레이터 사용을 위해)
    ScheduleModule.forRoot(),
    TypeOrmModule.forRoot({
      type: 'mysql',
      host: process.env.DB_HOST || 'localhost',
      port: +process.env.DB_PORT || 3306,
      username: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWD || 'test',
      database: process.env.DB_NAME || 'test_db',
      entities: [QuizSetModel, QuizModel, QuizChoiceModel, UserModel, UserQuizArchiveModel, ChatMessageModel],
      synchronize: process.env.DEV ? true : false, // 개발 모드에서만 활성화
      migrations: [join(__dirname, 'database', 'migrations', '*.js')],
      migrationsRun: !process.env.DEV,
      migrationsTableName: 'typeorm_migrations',
      logging: process.env.DEV ? true : ['error', 'warn', 'migration'],
      // extra: {
      //   // 글로벌 batch size 설정
      //   maxBatchSize: 100
      // }
    }),
    RedisModule.forRoot({
      type: 'single',
      url: process.env.REDIS_URL || 'redis://localhost:6379'
    }),
    QuizSetModule,
    UserModule,
    InitDBModule,
    WaitingRoomModule,
    TimeModule,
    AuthModule,
    MetricModule
  ],
  controllers: [AppController, TimeController],
  providers: [
    AppService,
    InactiveRoomScheduler,
    {
      provide: APP_INTERCEPTOR,
      useClass: ClassSerializerInterceptor
    }
  ]
})
export class AppModule {}
