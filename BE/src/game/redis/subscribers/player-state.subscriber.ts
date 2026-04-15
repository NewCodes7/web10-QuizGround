import { Injectable } from '@nestjs/common';
import { RedisSubscriber } from './base.subscriber';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { Namespace } from 'socket.io';
import SocketEvents from '../../../common/constants/socket-events';

@Injectable()
export class PlayerStateSubscriber extends RedisSubscriber {
  constructor(@InjectRedis() redis: Redis) {
    super(redis);
  }

  async subscribe(server: Namespace): Promise<void> {
    const subscriber = this.redis.duplicate();
    await subscriber.psubscribe('playerState:*');

    subscriber.on('pmessage', async (_pattern, channel, message) => {
      const gameId = channel.split(':')[1];
      if (!gameId) return;

      let payload: { type: string; [key: string]: unknown };
      try {
        payload = JSON.parse(message);
      } catch {
        return;
      }

      this.handlePlayerState(gameId, payload, server);
    });
  }

  private handlePlayerState(
    gameId: string,
    payload: { type: string; [key: string]: unknown },
    server: Namespace
  ) {
    switch (payload.type) {
      case 'Join':
        server.to(gameId).emit(SocketEvents.JOIN_ROOM, {
          players: [
            {
              playerId: payload.playerId,
              playerName: payload.playerName,
              playerPosition: [payload.positionX, payload.positionY],
              isHost: payload.isHost
            }
          ]
        });
        this.logger.verbose(`Player joined: ${payload.playerId} to game: ${gameId}`);
        break;

      case 'Disconnect':
        server.to(gameId).emit(SocketEvents.EXIT_ROOM, {
          playerId: payload.playerId
        });
        this.logger.verbose(`Player disconnected: ${payload.playerId} from game: ${gameId}`);
        break;

      case 'Name':
        server.to(gameId).emit(SocketEvents.SET_PLAYER_NAME, {
          playerId: payload.playerId,
          playerName: payload.playerName
        });
        this.logger.verbose(
          `Player Name Change: ${payload.playerName} ${payload.playerId} from game: ${gameId}`
        );
        break;

      case 'Kicked':
        server.to(gameId).emit(SocketEvents.KICK_ROOM, {
          playerId: payload.playerId
        });
        server.to(gameId).emit(SocketEvents.EXIT_ROOM, {
          playerId: payload.playerId
        });
        this.logger.verbose(`Player kicked: ${payload.playerId} from game: ${gameId}`);
        break;
    }
  }
}
