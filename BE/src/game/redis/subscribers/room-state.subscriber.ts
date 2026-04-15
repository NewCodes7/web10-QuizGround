import { Injectable } from '@nestjs/common';
import { RedisSubscriber } from './base.subscriber';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { Namespace } from 'socket.io';
import SocketEvents from '../../../common/constants/socket-events';

@Injectable()
export class RoomStateSubscriber extends RedisSubscriber {
  constructor(@InjectRedis() redis: Redis) {
    super(redis);
  }

  async subscribe(server: Namespace): Promise<void> {
    const subscriber = this.redis.duplicate();
    await subscriber.psubscribe('roomState:*');

    subscriber.on('pmessage', async (_pattern, channel, message) => {
      const gameId = channel.split(':')[1];
      if (!gameId) return;

      let payload: { type: string; [key: string]: unknown };
      try {
        payload = JSON.parse(message);
      } catch {
        return;
      }

      this.handleRoomState(gameId, payload, server);
    });
  }

  private handleRoomState(
    gameId: string,
    payload: { type: string; [key: string]: unknown },
    server: Namespace
  ) {
    switch (payload.type) {
      case 'Option':
        server.to(gameId).emit(SocketEvents.UPDATE_ROOM_OPTION, {
          title: payload.title,
          gameMode: payload.gameMode,
          maxPlayerCount: payload.maxPlayerCount,
          isPublic: payload.isPublic
        });
        this.logger.verbose(`Room option updated: ${gameId}`);
        break;

      case 'Quizset':
        server.to(gameId).emit(SocketEvents.UPDATE_ROOM_QUIZSET, {
          quizSetId: payload.quizSetId,
          quizCount: payload.quizCount
        });
        this.logger.verbose(`Room quizset updated: ${gameId}`);
        break;

      case 'Start':
        server.to(gameId).emit(SocketEvents.START_GAME, '');
        this.logger.verbose(`Game started: ${gameId}`);
        break;

      case 'Host':
        server.to(gameId).emit(SocketEvents.UPDATE_HOST, {
          hostId: payload.hostId
        });
        this.logger.verbose(`Update Host: ${gameId}`);
        break;
    }
  }
}
