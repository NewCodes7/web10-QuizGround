import { socketService } from '@/api/socket';
import { useChatStore } from './store/useChatStore';
import { usePlayerStore } from './store/usePlayerStore';
import { useQuizStore } from './store/useQuizStore';
import { useRoomStore } from './store/useRoomStore';
import GameState from '@/constants/gameState';
import QuizState from '@/constants/quizState';
import { getQuizSetDetail } from '@/api/rest/quizApi';
import { getEmojiByUUID } from '../utils/emoji';

// chat
socketService.on('chatMessage', (data) => {
  if (Array.isArray(data)) {
    data.forEach((e) => {
      useChatStore.getState().addMessage(e);
    });
  } else {
    useChatStore.getState().addMessage(data);
  }
});

// player
socketService.on('joinRoom', (data) => {
  const { addPlayers, currentPlayerId, currentPlayerName, setCurrentPlayerName } =
    usePlayerStore.getState();
  const newPlayers = data.players.map((player) => ({
    ...player,
    playerScore: 0,
    isAlive: true,
    isAnswer: true,
    emoji: getEmojiByUUID(player.playerId)
  }));
  addPlayers(newPlayers);

  // 현재 플레이어 이름이 없다면
  if (!currentPlayerName && currentPlayerId) {
    const me = data.players.find((e) => e.playerId == currentPlayerId);
    if (me) setCurrentPlayerName(me.playerName);
  }
});

// 방 단위 마지막으로 받은 seq 추적 (gap 감지용)
const roomSeqMap = new Map<string, number>();
// 플레이어 단위 마지막으로 적용된 seq 추적 (재전송 중복 적용 방지)
const playerAppliedSeqMap = new Map<string, number>();

socketService.on('updatePosition', (data) => {
  // 신규 포맷: { seq, updates: [{playerId, playerPosition}] }
  // 구 포맷 호환: [{playerId, playerPosition}] 또는 {playerId, playerPosition}
  const isFramed = !Array.isArray(data) && data.updates !== undefined;
  const updates: { playerId: string; playerPosition: [number, number] }[] = isFramed
    ? data.updates
    : Array.isArray(data)
      ? data
      : [data];
  const seq: number | undefined = isFramed ? data.seq : undefined;

  if (seq !== undefined) {
    const gameId = useRoomStore.getState().gameId;
    if (gameId) {
      const last = roomSeqMap.get(gameId) ?? 0;
      if (last > 0 && seq > last + 1) {
        socketService.emit('retransmitPosition', { gameId, lastSeq: last });
      }
      roomSeqMap.set(gameId, seq);
    }
  }

  updates.forEach((e) => {
    if (seq !== undefined) playerAppliedSeqMap.set(e.playerId, seq);
    usePlayerStore.getState().updatePlayerPosition(e.playerId, e.playerPosition);
  });
});

socketService.on('positionRetransmitResponse', (data) => {
  const gameId = useRoomStore.getState().gameId;
  if (gameId) {
    roomSeqMap.set(gameId, Math.max(roomSeqMap.get(gameId) ?? 0, data.seq));
  }
  (data.updates ?? []).forEach((e: { playerId: string; playerPosition: [number, number]; appliedSeq: number }) => {
    const currentApplied = playerAppliedSeqMap.get(e.playerId) ?? 0;
    if (e.appliedSeq > currentApplied) {
      playerAppliedSeqMap.set(e.playerId, e.appliedSeq);
      usePlayerStore.getState().updatePlayerPosition(e.playerId, e.playerPosition);
    }
  });
});

socketService.on('endQuizTime', (data) => {
  const { players, setPlayers } = usePlayerStore.getState();
  const { gameMode } = useRoomStore.getState();

  setPlayers(
    data.players.map((p) => {
      const _p = players.get(p.playerId);
      return {
        playerId: p.playerId,
        playerName: _p?.playerName || '',
        playerPosition: _p?.playerPosition || [0, 0],
        playerScore: p.score,
        isAnswer: p.isAnswer,
        isAlive: _p?.isAlive || false,
        isHost: _p?.isHost || false,
        emoji: _p?.emoji || 'o'
      };
    })
  );

  // 서바이벌 모드일 경우 3초 뒤에 탈락한 플레이어를 보이지 않게 한다.
  // TODO: 입장한 방이 어떤 게임 모드인지 알 수 없다.
  if (gameMode === 'SURVIVAL') {
    setTimeout(() => {
      const { players, setPlayers } = usePlayerStore.getState();

      setPlayers(
        Array.from(players, ([, p]) => {
          return {
            ...p,
            isAlive: p.isAlive && p?.isAnswer
          };
        })
      );
    }, 3000);
  }
});

socketService.on('endGame', (data) => {
  usePlayerStore.getState().setHost(data.hostId);
});

socketService.on('exitRoom', (data) => {
  usePlayerStore.getState().removePlayer(data.playerId);
});

socketService.on('getSelfId', (data) => {
  usePlayerStore.getState().setCurrentPlayerId(data.playerId);
  const playerName = usePlayerStore.getState().players.get(data.playerId)?.playerName;
  if (playerName) usePlayerStore.getState().setCurrentPlayerName(playerName);
});

socketService.on('setPlayerName', (data) => {
  usePlayerStore.getState().setPlayerName(data.playerId, data.playerName);
  if (data.playerId === usePlayerStore.getState().currentPlayerId) {
    usePlayerStore.getState().setCurrentPlayerName(data.playerName);
  }
});

socketService.on('kickRoom', (data) => {
  usePlayerStore.getState().removePlayer(data.playerId);
});

socketService.on('updateHost', (data) => {
  usePlayerStore.getState().setHost(data.hostId);
});

// Quiz

// 진행 중인 퀴즈 설정
socketService.on('startQuizTime', (data) => {
  useQuizStore.getState().setQuizState(QuizState.START);
  useQuizStore.getState().setCurrentQuiz(data);
});
socketService.on('endQuizTime', (data) => {
  useQuizStore.getState().setQuizState(QuizState.END);
  useQuizStore.getState().setCurrentAnswer(Number(data.answer));
});

socketService.on('endGame', () => {
  useQuizStore.getState().resetQuiz();
});

// TODO update 퀴즈 셋 시 퀴즈셋 받아오기
socketService.on('updateRoomQuizset', async (data) => {
  if (Number(data.quizSetId) < 0) return;
  const res = await getQuizSetDetail(String(data.quizSetId));
  useQuizStore.getState().setQuizSet(String(res?.title), String(res?.category));
});

// Room

socketService.on('createRoom', (data) => {
  useRoomStore.getState().updateRoom({ gameId: data.gameId });
});

socketService.on('updateRoomOption', (data) => {
  useRoomStore.getState().updateRoom(data);
});

socketService.on('startGame', () => {
  useRoomStore.getState().setGameState(GameState.PROGRESS);
});

socketService.on('endGame', () => {
  useRoomStore.getState().setGameState(GameState.END);
});
// 소켓 연결 해제시 초기화

socketService.on('disconnect', () => {
  useRoomStore.getState().reset();
  usePlayerStore.getState().reset();
  useChatStore.getState().reset();
  useQuizStore.getState().reset();
  roomSeqMap.clear();
  playerAppliedSeqMap.clear();
});
