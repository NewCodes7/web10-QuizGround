import { Module } from '@nestjs/common';
import { RedisModule } from '@nestjs-modules/ioredis';
import { DebugController } from './debug.controller';

@Module({
  imports: [RedisModule],
  controllers: [DebugController],
})
export class DebugModule {}
