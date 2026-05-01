import { io } from 'socket.io-client';
import * as msgpackParser from 'socket.io-msgpack-parser';
import SocketEvents from '@/constants/socketEvents';
import { SocketDataMap } from './socketEventTypes';
import mockMap from './mocks/socketMocks';

type SocketEvent = keyof SocketDataMap;

type SocketInterface = {
  connected: boolean;
  id: string;

  emit: <T extends SocketEvent>(event: T, data: SocketDataMap[T]['request']) => void;

  on: <T extends SocketEvent>(
    event: string,
    callback: (data: SocketDataMap[T]['response']) => void
  ) => void;

  off: <T extends SocketEvent>(
    event: string,
    callback: (data: SocketDataMap[T]['response']) => void
  ) => void;

  onAny: <T extends SocketEvent>(
    callback: (event: T, data: SocketDataMap[T]['response']) => void
  ) => void;

  disconnect: () => void;
};

class SocketService {
  private socket: SocketInterface | null;
  private url: string;
  private handlerMap: Partial<
    Record<SocketEvent, ((data: SocketDataMap[SocketEvent]['response']) => void)[]>
  > = {};
  private log = true;

  constructor(url: string) {
    this.socket = null;
    this.url = url;
  }

  async connect(header: { 'create-room'?: string; 'game-id'?: string }) {
    if (this.isActive()) return;
    const gameId = header['game-id'];
    if (gameId && gameId in mockMap) {
      // mock과 연결
      this.socket = new mockMap[gameId as keyof typeof mockMap]() as SocketInterface;
    } else {
      // 소켓 연결
      this.socket = io(this.url, { query: header, withCredentials: true, parser: msgpackParser }) as SocketInterface;
    }
    this.initHandler();
    await new Promise<void>((resolve, reject) => {
      if (!this.socket) return;
      this.socket.on('connect', () => resolve());
      this.socket.on('error', () => reject());
    });
  }

  initHandler() {
    if (!this.socket) return;
    const socket = this.socket;
    Object.entries(this.handlerMap).forEach(([event, handlers]) =>
      handlers.forEach((h) => socket.on(event, h))
    );
    this.socket.onAny((eventName, ...args) => {
      if (this.log) {
        if (eventName === 'exception')
          console.log(`%cSOCKET[${eventName}]`, 'color:red', Date.now(), ...args);
        else if (eventName !== 'updatePosition' && eventName !== 'chatMessage')
          console.log(`%cSOCKET[${eventName}]`, 'color:green', Date.now(), ...args);
        else console.log(`SOCKET[${eventName}]`, ...args);
      }
    });
  }

  disconnect() {
    if (this.socket && this.isActive()) this.socket.disconnect();
  }

  isActive() {
    return this.socket && this.socket.connected;
  }

  on<T extends SocketEvent>(event: T, callback: (data: SocketDataMap[T]['response']) => void) {
    if (this.socket) this.socket.on(event, callback);
    if (!this.handlerMap[event]) this.handlerMap[event] = [];
    this.handlerMap[event].push(callback);
  }

  off<T extends SocketEvent>(event: T, callback: (data: SocketDataMap[T]['response']) => void) {
    if (!this.handlerMap[event]) return;
    if (this.socket) this.socket.off(event, callback);
    this.handlerMap[event] = this.handlerMap[event].filter((e) => e !== callback);
  }

  emit<T extends SocketEvent>(event: T, data: SocketDataMap[T]['request']) {
    if (!this.socket) return;
    this.socket.emit(event, data);
    if (this.log) console.log(`%cSOCKET[${event}]`, 'background-color:blue', Date.now(), data);
  }

  async createRoom(option: {
    title: string;
    gameMode: 'RANKING' | 'SURVIVAL';
    maxPlayerCount: number;
    isPublic: boolean;
  }) {
    this.disconnect();
    await this.connect({
      'create-room': Object.entries(option)
        .map(([key, value]) => key + '=' + value)
        .join(';')
    });
  }

  async joinRoom(gameId: string) {
    await this.connect({ 'game-id': gameId });
  }

  kickRoom(gameId: string, kickPlayerId: string) {
    if (!this.socket) return;
    this.socket.emit(SocketEvents.KICK_ROOM, { gameId, kickPlayerId });
  }

  chatMessage(gameId: string, message: string) {
    if (!this.socket) return;
    this.socket.emit(SocketEvents.CHAT_MESSAGE, { gameId, message });
  }
}

const socketUrl =
  import.meta.env.VITE_SOCKET_URL ||
  (import.meta.env.DEV ? 'http://localhost:3000/game' : `${window.location.origin}/game`);
export const socketService = new SocketService(socketUrl);
