const SocketEvents = {
  CHAT_MESSAGE: 'chatMessage',
  UPDATE_POSITION: 'updatePosition',
  CREATE_ROOM: 'createRoom',
  UPDATE_ROOM_OPTION: 'updateRoomOption',
  UPDATE_ROOM_QUIZSET: 'updateRoomQuizset',
  JOIN_ROOM: 'joinRoom',
  START_GAME: 'startGame',
  STOP_GAME: 'stopGame',
  END_QUIZ_TIME: 'endQuizTime',
  START_QUIZ_TIME: 'startQuizTime',
  UPDATE_SCORE: 'updateScore',
  KICK_ROOM: 'kickRoom',
  RETRANSMIT_CHAT: 'retransmitChat',
  CHAT_RETRANSMIT_RESPONSE: 'chatRetransmitResponse'
} as const;

export default SocketEvents;
