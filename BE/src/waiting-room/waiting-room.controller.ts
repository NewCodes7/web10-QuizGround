import { Controller, Get, Logger, ParseIntPipe, Query } from '@nestjs/common';
import { WaitingRoomService } from './waiting-room.service';
import { ParseIntOrDefault } from '../common/decorators/parse-int-or-default.decorator';

@Controller('/api/rooms')
export class WaitingRoomController {
  constructor(private readonly waitingRoomService: WaitingRoomService) {}

  @Get()
  async findAll(
    // 참고: @nestjs/common의 DefaultValuePipe는 빈 문자열이 왔을 때는 대응 못함
    @Query('cursor', new ParseIntOrDefault(0)) cursor: number,
    @Query('take', new ParseIntOrDefault(10), ParseIntPipe) take: number
  ) {
    return this.waitingRoomService.findAllWaitingRooms(cursor, take);
  }
}
