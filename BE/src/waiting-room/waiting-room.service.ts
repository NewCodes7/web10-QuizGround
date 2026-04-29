import { Injectable, Logger } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { RoomDto, RoomListResponseDto } from './dto/waiting-room-list.response.dto';

@Injectable()
export class WaitingRoomService {
  private logger = new Logger('WaitingRoom');

  constructor(@InjectRedis() private readonly redis: Redis) {}

  async findAllWaitingRooms(cursor: number, take: number): Promise<RoomListResponseDto> {
    const rooms: RoomDto[] = [];

    const roomKeys = await this.redis.keys('Room:*');
    const gameRoomKeys = roomKeys.filter((key) => {
      const parts = key.split(':');
      return parts.length === 2 && parts[0] === 'Room';
    });

    // TODO: 현재는 gameId를 기준으로 정렬하고 있으나, 정렬 기준으로 별도로 잡는 게 좋아보임 (redis에 room별로 고유한 id를 부여하거나)
    gameRoomKeys.sort((a, b) => {
      const gameIdA = parseInt(a.split(':')[1]);
      const gameIdB = parseInt(b.split(':')[1]);
      return gameIdB - gameIdA;
    });

    // cursor 기반 필터링
    let startIndex = 0;
    if (cursor) {
      const cursorGameId = cursor;
      startIndex = gameRoomKeys.findIndex((key) => key === `Room:${cursorGameId}`) + 1;
      if (startIndex === 0) {
        // cursor를 찾지 못한 경우
        return new RoomListResponseDto([], null, false);
      }
    }

    // take + 1개를 가져와서 다음 페이지 존재 여부 확인
    const targetKeys = gameRoomKeys.slice(startIndex, startIndex + take + 1);

    for (const roomKey of targetKeys) {
      const gameId = roomKey.split(':')[1];
      const roomInfo = await this.redis.hgetall(roomKey);

      if (roomInfo.isWaiting !== '1') {
        continue;
      }

      const currentPlayerCount = await this.redis.scard(`Room:${gameId}:Players`);
      rooms.push({
        title: roomInfo.title,
        gameMode: roomInfo.gameMode,
        maxPlayerCount: parseInt(roomInfo.maxPlayerCount),
        currentPlayerCount: currentPlayerCount,
        quizSetTitle: roomInfo.quizSetTitle,
        gameId: gameId
      });
    }

    const hasNextPage = rooms.length > take;
    const responseRooms = hasNextPage ? rooms.slice(0, take) : rooms;
    const nextCursor = hasNextPage ? responseRooms[responseRooms.length - 1].gameId : null;

    this.logger.verbose(
      `방 목록 조회: cursor=${cursor}, take=${take}, rooms=${rooms.length}, nextCursor=${nextCursor}`
    );

    return new RoomListResponseDto(responseRooms, nextCursor, hasNextPage);
  }
}
