import { Module } from '@nestjs/common';
import { WaitingRoomService } from './waiting-room.service';
import { WaitingRoomController } from './waiting-room.controller';
import { RedisModule } from '@nestjs-modules/ioredis';

@Module({
  imports: [RedisModule],
  controllers: [WaitingRoomController],
  providers: [WaitingRoomService]
})
export class WaitingRoomModule {}
