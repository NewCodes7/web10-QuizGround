export const ExceptionMessage = {
  ROOM_NOT_FOUND: '존재하지 않는 게임 방입니다.',
  ROOM_FULL: '게임 방 최대 인원이 모두 찼습니다.',
  NOT_A_PLAYER: '해당 게임 방의 플레이어가 아닙니다.',
  ONLY_HOST: '방장이 아닙니다.',
  GAME_NOT_STARTED: '게임이 시작되지 않았습니다.',
  EXCEEDS_QUIZ_SET_LIMIT: '선택된 퀴즈 수가 퀴즈셋에 있는 퀴즈 수를 초과했습니다.',
  GAME_ALREADY_STARTED: '게임이 이미 시작되었습니다.',
  PLAYER_NOT_FOUND: '존재하지 않는 플레이어입니다.',
  CONNECTION_ERROR:
    '\n소켓 연결시 title,gameMode,maxPlayerCount,isPublic 이 있어야 합니다. 또는 참가할 game-id가 있어야 합니다.',
  // TICKET-001
  UNAUTHORIZED_ROOM_ACCESS: '해당 게임 방에 대한 접근 권한이 없습니다.',
  INVALID_SEQ: 'lastSeq는 0 이상이어야 합니다.',
  INVALID_INPUT: '잘못된 입력입니다.'
};
