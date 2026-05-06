import { Module } from '@nestjs/common';
import { RedisModule } from '@nestjs-modules/ioredis';
import { DebugController } from './debug.controller';
import { HeapSnapshotService } from './heap-snapshot.service';

@Module({
  imports: [RedisModule],
  controllers: [DebugController],
  providers: [HeapSnapshotService],
  exports: [HeapSnapshotService],
})
export class DebugModule {}
