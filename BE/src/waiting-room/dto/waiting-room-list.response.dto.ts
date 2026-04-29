import { PagingDto } from '../../quiz-set/dto/quiz-set-list-response.dto';

export class RoomDto {
  title: string;
  gameMode: string;
  maxPlayerCount: number;
  currentPlayerCount: number;
  quizSetTitle: string;
  gameId: string;

  constructor(
    title: string,
    gameMode: string,
    maxPlayerCount: number,
    currentPlayerCount: number,
    quizSetTitle: string,
    gameId: string
  ) {
    this.title = title;
    this.gameMode = gameMode;
    this.maxPlayerCount = maxPlayerCount;
    this.currentPlayerCount = currentPlayerCount;
    this.quizSetTitle = quizSetTitle;
    this.gameId = gameId;
  }
}

export class RoomListResponseDto {
  roomList: RoomDto[];
  paging: PagingDto;

  constructor(roomList: RoomDto[], nextCursor: string, hasNextPage: boolean) {
    this.roomList = roomList;
    this.paging = {
      nextCursor,
      hasNextPage
    };
  }
}
