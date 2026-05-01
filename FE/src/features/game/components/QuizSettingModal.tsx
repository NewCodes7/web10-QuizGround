import { useEffect, useRef, useState } from 'react';
import { QuizPreview } from '../../../components/QuizPreview';
import { socketService, useSocketEvent } from '@/api/socket';
import QuizSetSearchList from './QuizSetSearchList';
import { useRoomStore } from '@/features/game/data/store/useRoomStore';

type QuizSet = {
  id: string;
  title: string;
  category: string;
  quizCount: number;
};

type Props = {
  isOpen: boolean;
  onClose: () => void;
};

export const QuizSettingModal = ({ isOpen, onClose }: Props) => {
  const gameId = useRoomStore((state) => state.gameId);
  const [selectedQuizSet, setSelectedQuizSet] = useState<null | QuizSet>(null);
  const [inputValue, setInputValue] = useState('');
  const [searchParam, setSearchParam] = useState('');
  const [quizCount, setQuizCount] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const searchTimeoutRef = useRef<null | ReturnType<typeof setTimeout>>(null);

  // 타이핑 시 0.3초 뒤에 검색
  useEffect(() => {
    const trimedInputValue = inputValue.trim();
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => {
      if (trimedInputValue !== searchParam) {
        setSearchParam(trimedInputValue);
        if (scrollRef.current) scrollRef.current.scrollTop = 0;
      }
    }, 300);
    return () => {
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    };
  }, [inputValue]);

  useSocketEvent('updateRoomQuizset', () => {
    onClose();
  });

  const handleChangeSetting = () => {
    if (!selectedQuizSet) return;
    socketService.emit('updateRoomQuizset', {
      gameId,
      quizSetId: Number(selectedQuizSet.id),
      quizCount: quizCount
    });
  };

  const handleSelectQuizSet = (quizSet: QuizSet) => {
    setSelectedQuizSet(quizSet);
    setQuizCount(quizSet.quizCount);
  };

  return (
    <div
      className="fixed inset-0 flex items-center justify-center bg-black bg-opacity-50 z-10 animate-popup"
      style={{ display: isOpen ? 'flex' : 'none' }}
    >
      <div className="component-popup max-w-[90vw] w-[40rem]">
        <div>
          <div className="flex justify-between p-5 h-20">
            <form
              className="relative flex-grow flex items-center"
              onSubmit={(e) => e.preventDefault()}
            >
              <input
                className="absolute pl-8 bg-gray-100 border border-gray-200 rounded-xl h-[100%] w-[100%]"
                type="text"
                id="quiz-search-bar"
                placeholder="퀴즈 이름 또는 카테고리"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
              />
              <div className="absolute left-2">🍭</div>
            </form>
            <button className="font-black ml-4" onClick={onClose}>
              ✕
            </button>
          </div>
          <div className="flex flex-col pl-2 pr-2 h-[30vh] overflow-y-auto" ref={scrollRef}>
            <QuizSetSearchList search={searchParam} onClick={handleSelectQuizSet} />
          </div>
        </div>
        <div className="border-t border-default">
          {selectedQuizSet ? (
            <div className="flex flex-col p-4 gap-4">
              <div className="font-bold text-lg">선택된 퀴즈</div>
              <QuizPreview title={selectedQuizSet.title} description={selectedQuizSet.category} />
              <div>
                <span className="mr-4">{`퀴즈 개수(${quizCount})`}</span>
                <input
                  type="range"
                  min={1}
                  max={selectedQuizSet.quizCount}
                  value={quizCount}
                  onChange={(e) => setQuizCount(Number(e.target.value))}
                />
              </div>
              <div className="flex flex-row-reverse">
                <button
                  className="bg-main text-white font-bold rounded-md w-20 h-8"
                  onClick={handleChangeSetting}
                >
                  설정 완료
                </button>
              </div>
            </div>
          ) : (
            <div className="h-[10rem] flex justify-center items-center text-gray-400">
              퀴즈를 선택해주세요
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
