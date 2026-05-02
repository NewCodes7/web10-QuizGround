import { io, Socket } from 'socket.io-client';
import * as msgpackParser from '../../../src/common/parser/msgpackr.parser';
import socketEvents from '../../../src/common/constants/socket-events';

type ConnectClientsResponse = {
  clients: Map<string, Socket>;
  gameId: string;
};

export class SocketTestHelper {
  private clients: Map<string, Socket> = new Map();
  private gameId: string;

  async connectClients(port: number, count: number): Promise<ConnectClientsResponse> {
    await this.disconnectAll(); // 기존 연결이 있다면 정리

    if (count === 0) {
      return;
    }

    return new Promise<ConnectClientsResponse>((resolve) => {
      let connectedClients = 0;

      const createClient = io(`http://localhost:${port}/game`, {
        transports: ['websocket'],
        forceNew: true,
        parser: msgpackParser,
        query: {
          'create-room': 'title=Test Room;gameMode=RANKING;maxPlayerCount=5;isPublic=true'
        }
      });
      createClient.once(socketEvents.GET_SELF_ID, (data) => {
        this.clients.set(data.playerId, createClient);
        connectedClients++;
        if (connectedClients === count) {
          resolve({ clients: this.clients, gameId: this.gameId });
        }
      });
      createClient.once(socketEvents.CREATE_ROOM, (data) => {
        this.gameId = data.gameId;
        for (let i = 1; i < count; i++) {
          const client = io(`http://localhost:${port}/game`, {
            transports: ['websocket'],
            forceNew: true,
            parser: msgpackParser,
            query: {
              'game-id': this.gameId
            }
          });
          client.once(socketEvents.GET_SELF_ID, (data) => {
            this.clients.set(data.playerId, client);
            connectedClients++;
            if (connectedClients === count) {
              resolve({ clients: this.clients, gameId: this.gameId });
            }
          });
        }
      });
    });
  }

  async disconnectAll() {
    for (const client of this.clients.values()) {
      if (client && client.connected) {
        client.disconnect();
      }
    }
    this.clients = new Map();
  }

  getClient(index: number): Socket {
    if (index < 0 || index >= this.clients.size) {
      throw new Error(`Invalid client index: ${index}`);
    }
    return this.clients[index];
  }
}
