import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer
} from '@nestjs/websockets';
import { Namespace, Socket } from 'socket.io';
import { Logger, UseFilters, UseInterceptors, UsePipes } from '@nestjs/common';
import { WsExceptionFilter } from '../common/filters/ws-exception.filter';
import SocketEvents from '../common/constants/socket-events';
import { ChatMessageDto } from './dto/chat-message.dto';
import { GameSessionService } from './service/game-session.service';
import { UpdatePositionDto } from './dto/update-position.dto';
import { GameValidationPipe } from './middleware/game-validation.pipe';
import { StartGameDto } from './dto/start-game.dto';
import { UpdateRoomOptionDto } from './dto/update-room-option.dto';
import { UpdateRoomQuizsetDto } from './dto/update-room-quizset.dto';
import { GameChatService } from './service/game-chat.service';
import { GameRoomService } from './service/game-room.service';
import { GameActivityInterceptor } from './middleware/game-activity.interceptor';
import { parse, serialize } from 'cookie';
import { v4 as uuidv4 } from 'uuid';
import { SetPlayerNameDto } from './dto/set-player-name.dto';
import { KickRoomDto } from './dto/kick-room.dto';
import { ExceptionMessage } from '../common/constants/exception-message';
import { MetricInterceptor } from '../metric/metric.interceptor';
import { MetricService } from '../metric/metric.service';
import { PositionBroadcastService } from './service/position-broadcast.service';
import { RetransmitPositionDto } from './dto/retransmit-position.dto';
import { RetransmitChatDto } from './dto/retransmit-chat.dto';
import * as msgpackParser from '../common/parser/msgpackr.parser';

const CORS_ORIGINS: (string | RegExp)[] = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
  'https://news.taskify.shop',
  'https://quizground.duckdns.org',
  'https://quizground.site',
  /\.app\.github\.dev$/
];

if (process.env.CORS_ORIGIN) {
  CORS_ORIGINS.push(...process.env.CORS_ORIGIN.split(',').map((o) => o.trim()));
}

@UseInterceptors(MetricInterceptor)
@UseInterceptors(GameActivityInterceptor)
@UseFilters(new WsExceptionFilter())
@WebSocketGateway({
  cors: {
    origin: CORS_ORIGINS,
    credentials: true
  },
  namespace: '/game',
  parser: msgpackParser
})
export class GameGateway {
  @WebSocketServer()
  server: Namespace;
  private logger = new Logger('GameGateway');

  constructor(
    private readonly gameSessionService: GameSessionService,
    private readonly gameChatService: GameChatService,
    private readonly gameRoomService: GameRoomService,
    private readonly positionBroadcastService: PositionBroadcastService,
    private readonly metricService: MetricService
  ) {}

  @SubscribeMessage(SocketEvents.UPDATE_POSITION)
  async handleUpdatePosition(
    @MessageBody() updatePosition: UpdatePositionDto,
    @ConnectedSocket() client: Socket
  ): Promise<void> {
    await this.gameSessionService.updatePosition(updatePosition, client.data.playerId);
  }

  @SubscribeMessage(SocketEvents.RETRANSMIT_POSITION)
  @UsePipes(new GameValidationPipe(SocketEvents.RETRANSMIT_POSITION))
  async handleRetransmitPosition(
    @MessageBody() dto: RetransmitPositionDto,
    @ConnectedSocket() client: Socket
  ): Promise<void> {
    await this.positionBroadcastService.handleRetransmit(dto, client.data.playerId, client);
  }

  @SubscribeMessage(SocketEvents.CHAT_MESSAGE)
  async handleChatMessage(
    @MessageBody() chatMessage: ChatMessageDto,
    @ConnectedSocket() client: Socket
  ): Promise<void> {
    await this.gameChatService.chatMessage(chatMessage, client.data.playerId);
  }

  @SubscribeMessage(SocketEvents.RETRANSMIT_CHAT)
  @UsePipes(new GameValidationPipe(SocketEvents.RETRANSMIT_CHAT))
  async handleRetransmitChat(
    @MessageBody() dto: RetransmitChatDto,
    @ConnectedSocket() client: Socket
  ): Promise<void> {
    await this.gameChatService.handleRetransmit(dto, client.data.playerId, client);
  }

  @SubscribeMessage(SocketEvents.UPDATE_ROOM_OPTION)
  @UsePipes(new GameValidationPipe(SocketEvents.UPDATE_ROOM_OPTION))
  async handleUpdateRoomOption(
    @MessageBody() updateRoomOptionDto: UpdateRoomOptionDto,
    @ConnectedSocket() client: Socket
  ) {
    await this.gameRoomService.updateRoomOption(updateRoomOptionDto, client.data.playerId);
  }

  @SubscribeMessage(SocketEvents.UPDATE_ROOM_QUIZSET)
  @UsePipes(new GameValidationPipe(SocketEvents.UPDATE_ROOM_QUIZSET))
  async handleUpdateRoomQuizset(
    @MessageBody() updateRoomQuizsetDto: UpdateRoomQuizsetDto,
    @ConnectedSocket() client: Socket
  ) {
    await this.gameRoomService.updateRoomQuizset(updateRoomQuizsetDto, client.data.playerId);
  }

  @SubscribeMessage(SocketEvents.START_GAME)
  @UsePipes(new GameValidationPipe(SocketEvents.START_GAME))
  async handleStartGame(
    @MessageBody() startGameDto: StartGameDto,
    @ConnectedSocket() client: Socket
  ) {
    await this.gameSessionService.startGame(startGameDto, client.data.playerId);
  }

  @SubscribeMessage(SocketEvents.SET_PLAYER_NAME)
  @UsePipes(new GameValidationPipe(SocketEvents.SET_PLAYER_NAME))
  async handleSetPlayerName(
    @MessageBody() setPlayerNameDto: SetPlayerNameDto,
    @ConnectedSocket() client: Socket
  ) {
    await this.gameSessionService.setPlayerName(setPlayerNameDto, client.data.playerId);
  }

  @SubscribeMessage(SocketEvents.KICK_ROOM)
  @UsePipes(new GameValidationPipe(SocketEvents.KICK_ROOM))
  async handleKickRoom(@MessageBody() kickRoomDto: KickRoomDto, @ConnectedSocket() client: Socket) {
    await this.gameRoomService.kickRoom(kickRoomDto, client.data.playerId);
  }

  afterInit(nameSpace: Namespace) {
    this.logger.verbose('WebSocket 서버 초기화 완료했어요!');

    this.gameSessionService.subscribeRedisEvent(this.server).then(() => {
      this.logger.verbose('Redis 이벤트 등록 완료했어요!');
    });
    // Position batch timer slots 시작 (TICKET-003/007)
    this.positionBroadcastService.initTimers(this.server);
    this.logger.verbose('Position broadcast timer slots 초기화 완료했어요!');

    // Chat Streams timer slots 시작
    this.gameChatService.initTimers(this.server);
    this.logger.verbose('Chat Streams timer slots 초기화 완료했어요!');

    this.server.server.engine.on('headers', (headers, request) => {
      this.initialHeaders(headers, request);
    });
  }

  initialHeaders(headers, request) {
    if (!request.headers.cookie) {
      request.headers['player-id'] = this.setNewPlayerIdToCookie(headers);
      return;
    }
    const cookies = parse(request.headers.cookie);
    if (!cookies.playerId) {
      request.headers['player-id'] = this.setNewPlayerIdToCookie(headers);
      return;
    }
    request.headers['player-id'] = cookies.playerId;
  }

  setNewPlayerIdToCookie(headers) {
    const playerId = uuidv4();
    const isSecureCookie = process.env.COOKIE_SECURE === 'true';
    headers['Set-Cookie'] = serialize('playerId', playerId, {
      sameSite: isSecureCookie ? 'none' : 'lax',
      secure: isSecureCookie
    });
    return playerId;
  }

  async handleConnection(client: Socket) {
    try {
      await this.gameSessionService.connection(client);
      this.logger.verbose(`클라이언트가 연결되었어요!: ${client.data.playerId}`);
    } catch (error) {
      this.logger.error(`Connection error: ${error.message + ExceptionMessage.CONNECTION_ERROR}`);
      client.emit('exception', {
        event: 'connection',
        message: error.message + ExceptionMessage.CONNECTION_ERROR
      });
      client.disconnect(true);
      return;
    }
    // server.sockets.sockets.size는 동기 O(1) — 응답 경로 블로킹 없음
    this.metricService.setWsClients(this.server.sockets.size);
  }

  async handleDisconnect(client: Socket) {
    this.logger.verbose(`클라이언트가 연결 해제되었어요!: ${client.data.playerId}`);
    await this.gameRoomService.handlePlayerExit(client.data.playerId);
    this.metricService.setWsClients(this.server.sockets.size);
  }
}
