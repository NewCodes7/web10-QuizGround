import { Injectable } from '@nestjs/common';
import { RedisSubscriber } from './base.subscriber';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { Namespace } from 'socket.io';
import SocketEvents from '../../../common/constants/socket-events';

@Injectable()
export class RoomSubscriber extends RedisSubscriber {
  constructor(@InjectRedis() redis: Redis) {
    super(redis);
  }

  async subscribe(server: Namespace): Promise<void> {
    const subscriber = this.redis.duplicate();
    await subscriber.psubscribe('__keyspace@0__:Room:*');

    subscriber.on('pmessage', async (_pattern, channel, message) => {
      const gameId = this.extractGameId(channel);
      if (!gameId || message !== 'hset') {
        return;
      }

      const key = `Room:${gameId}`;
      await this.handleRoomChanges(key, gameId, server);
    });
  }

  private extractGameId(channel: string): string | null {
    const splitKey = channel.replace('__keyspace@0__:', '').split(':');
    return splitKey.length === 2 ? splitKey[1] : null;
  }

  private async handleRoomChanges(key: string, gameId: string, server: Namespace) {
    const changes = await this.redis.get(`${key}:Changes`);
    await this.redis.del(`${key}:Changes`);
    const roomData = await this.redis.hgetall(key);

    switch (changes) {
      case 'Option':
        server.to(gameId).emit(SocketEvents.UPDATE_ROOM_OPTION, {
          title: roomData.title,
          gameMode: roomData.gameMode,
          maxPlayerCount: parseInt(roomData.maxPlayerCount),
          isPublic: roomData.isPublic === '1'
        });
        this.logger.verbose(`Room option updated: ${gameId}`);
        break;

      case 'Quizset':
        server.to(gameId).emit(SocketEvents.UPDATE_ROOM_QUIZSET, {
          quizSetId: roomData.quizSetId,
          quizCount: parseInt(roomData.quizCount)
        });
        this.logger.verbose(`Room quizset updated: ${gameId}`);
        break;

      case 'Start':
        server.to(gameId).emit(SocketEvents.START_GAME, '');
        this.logger.verbose(`Game started: ${gameId}`);
        break;

      case 'Host':
        server.to(gameId).emit(SocketEvents.UPDATE_HOST, {
          hostId: roomData.host
        });
        this.logger.verbose(`Update Host: ${gameId}`);
        break;
    }
  }
}
