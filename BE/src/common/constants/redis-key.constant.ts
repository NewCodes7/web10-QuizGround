export const REDIS_KEY = {
  ROOM: (gameId: string) => `Room:${gameId}`,
  ROOM_PLAYERS: (gameId: string) => `Room:${gameId}:Players`,
  ROOM_QUIZ: (gameId: string, quizId: string) => `Room:${gameId}:Quiz:${quizId}`,
  ROOM_QUIZ_CHOICES: (gameId: string, quizId: string) => `Room:${gameId}:Quiz:${quizId}:Choices`,
  ROOM_LEADERBOARD: (gameId: string) => `Room:${gameId}:Leaderboard`,
  ROOM_CURRENT_QUIZ: (gameId: string) => `Room:${gameId}:CurrentQuiz`,
  ROOM_TIMER: (gameId: string) => `Room:${gameId}:Timer`,
  ROOM_QUIZ_SET: (gameId: string) => `Room:${gameId}:QuizSet`,
  ROOM_SCORING_COUNT: (gameId: string) => `Room:${gameId}:ScoringCount`,
  ROOM_SCORING_STATUS: (gameId: string) => `Room:${gameId}:ScoringStatus`,
  PLAYER: (playerId: string) => `Player:${playerId}`,
  QUIZSET_ID: (quizSetId: number) => `Quizset:${quizSetId}`,

  ACTIVE_ROOMS: 'ActiveRooms', // 활성화된 방 목록을 저장하는 Set (핀번호 중복 체크하기 위함)

  POSITION_CHANNEL: (gameId: string) => `position:${gameId}`,

  // 방 단위 authoritative seq (INCR, TICKET-004)
  ROOM_SEQ: (gameId: string) => `Room:${gameId}:Seq`,

  // 최근 N개 배치 로그 — Redis List (RPUSH/LTRIM, TICKET-006)
  ROOM_POSITION_LOG: (gameId: string) => `Room:${gameId}:PositionLog`
};
