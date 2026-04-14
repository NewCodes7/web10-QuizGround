import { create } from 'zustand';

type Message = {
  playerName: string;
  message: string;
  playerId: string;
  timestamp: number;
};

type ChatStore = {
  messages: Message[];
  addMessage: (message: Message) => void;
  addMessages: (messages: Message[]) => void;
  reset: () => void;
};

export const useChatStore = create<ChatStore>((set) => ({
  messages: [],
  addMessage: (message) => {
    set((state) => ({ messages: [...state.messages, message] }));
  },
  addMessages: (messages) => {
    if (messages.length === 0) return;
    set((state) => ({ messages: [...state.messages, ...messages] }));
  },
  reset: () => set({ messages: [] })
}));
