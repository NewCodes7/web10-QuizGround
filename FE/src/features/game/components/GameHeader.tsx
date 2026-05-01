import { ClipboardCopy } from '../../../components/ClipboardCopy';
import { useNavigate, useParams } from 'react-router-dom';
import { useRoomStore } from '@/features/game/data/store/useRoomStore';
import React, { useState } from 'react';
import { QuizSettingModal } from './QuizSettingModal';
import { socketService, useSocketEvent, useSocketException } from '@/api/socket';
import { usePlayerStore } from '@/features/game/data/store/usePlayerStore';
import { useQuizStore } from '@/features/game/data/store/useQuizStore';
import CustomButton from '@/components/CustomButton';

export const GameHeader = React.memo(
  ({ onChangeBackground }: { onChangeBackground: () => void }) => {
    const { gameId } = useParams<{ gameId: string }>();
    const players = usePlayerStore((state) => state.players);
    const currentPlayerId = usePlayerStore((state) => state.currentPlayerId);
    const isHost = players.get(currentPlayerId)?.isHost ?? false;
    const gameTitle = useRoomStore((state) => state.title);
    const [isQuizModalOpen, setIsQuizModalOpen] = useState(false);
    const { quizSetTitle, quizSetCategory } = useQuizStore();
    const [gameLoading, setGameLoading] = useState(false);
    const pinNum = String(gameId);
    const linkURL = window.location.hostname + `/game/${gameId}`;
    const gameMode = useRoomStore((state) => state.gameMode);
    const navigate = useNavigate();

    const handleStartGame = () => {
      if (gameLoading) return;
      setGameLoading(true);
      if (gameId) socketService.emit('startGame', { gameId });
    };

    useSocketEvent('startGame', () => setGameLoading(false));
    useSocketException('startGame', () => setGameLoading(false));

    return (
      <div className="component-default h-full flex justify-center">
        <div className="max-w-[666px] w-[95%] h-full">
          <div className="flex my-2">
            <ClipboardCopy valueToCopy={pinNum} message={`PIN: ${pinNum} 복사`} />
            <ClipboardCopy valueToCopy={linkURL} message="공유 링크 복사" />
          </div>
          <div className="flex justify-between gap-2">
            <div className="w-[calc(100%-100px)] flex-1 flex flex-col">
              <div className="truncate text-lg sm:text-2xl font-bold">
                <span className={gameMode === 'RANKING' ? 'text-blue-500' : 'text-red-500'}>
                  [{gameMode === 'RANKING' ? '랭킹 모드' : '생존 모드'}]
                </span>
                <span className="ml-2 animate-popup">{gameTitle}</span>
              </div>
              <div className="w-full mt-4 flex-1">
                {quizSetTitle ? (
                  <div className="component-default rounded-lg p-4 sm:mr-6 h-full flex flex-col justify-center animate-popup">
                    <div className="text-xs sm:text-sm mb-2 truncate text-blue-300">
                      {quizSetCategory}
                    </div>
                    <div className="text-md sm:text-xl font-bold line-clamp-2">{quizSetTitle}</div>
                  </div>
                ) : (
                  <div className="text-gray-400">퀴즈를 선택해 주세요</div>
                )}
              </div>
            </div>
            <div className="w-[100px] flex gap-2 flex-col">
              <CustomButton
                text="나가기"
                size="half"
                color="red"
                onClick={() => navigate('/')}
                className="shadow-md transform hover:translate-y-[-2px] hover:shadow-lg active:translate-y-1 active:shadow-sm transition w-full animate-popup h-[35px]"
              />
              <CustomButton
                text="배경 바꾸기"
                size="half"
                color="green"
                onClick={onChangeBackground}
                className="shadow-md transform hover:translate-y-[-2px] hover:shadow-lg active:translate-y-1 active:shadow-sm transition w-full animate-popup h-[35px]"
              />
              {isHost && (
                <>
                  <CustomButton
                    text="퀴즈 설정"
                    size="half"
                    color="blue"
                    onClick={() => setIsQuizModalOpen(true)}
                    className="shadow-md transform hover:translate-y-[-2px] hover:shadow-lg active:translate-y-1 active:shadow-sm transition w-full animate-popup h-[35px]"
                  />
                  <CustomButton
                    text="게임 시작"
                    size="half"
                    color="yellow"
                    onClick={handleStartGame}
                    className="shadow-md transform hover:translate-y-[-2px] hover:shadow-lg active:translate-y-1 active:shadow-sm transition w-full animate-popup h-[35px]"
                  />
                </>
              )}
            </div>
          </div>
        </div>
        {isQuizModalOpen && (
          <QuizSettingModal isOpen={isQuizModalOpen} onClose={() => setIsQuizModalOpen(false)} />
        )}
      </div>
    );
  }
);
