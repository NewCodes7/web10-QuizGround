import { Test, TestingModule } from '@nestjs/testing';
import { WaitingRoomService } from './waiting-room.service';

const DEFAULT_REDIS_NAMESPACE = 'default';
const REDIS_MODULE_CONNECTION_TOKEN = `${DEFAULT_REDIS_NAMESPACE}_IORedisModuleConnectionToken`;

describe('WaitingRoomService', () => {
  let service: WaitingRoomService;
  let redisMock: any;

  beforeEach(async () => {
    redisMock = {
      keys: jest.fn(),
      hgetall: jest.fn(),
      scard: jest.fn()
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WaitingRoomService,
        {
          provide: REDIS_MODULE_CONNECTION_TOKEN,
          useValue: redisMock
        }
      ]
    }).compile();

    service = module.get<WaitingRoomService>(WaitingRoomService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('findAllWaitingRooms', () => {
    it('대기중인 방 목록을 cursor 기반으로 정상적으로 반환한다', async () => {
      // Given
      const mockRoomKeys = ['Room:123', 'Room:456', 'Room:789'];
      const mockRoom1 = {
        title: '방 제목 1',
        gameMode: 'NORMAL',
        maxPlayerCount: '4',
        isWaiting: '1',
        quizSetId: '1',
        quizSetTitle: '즐거운 퀴즈모음1'
      };
      const mockRoom2 = {
        title: '방 제목 2',
        gameMode: 'SPEED',
        maxPlayerCount: '6',
        isWaiting: '1',
        quizSetId: '2',
        quizSetTitle: '즐거운 퀴즈모음2'
      };
      const mockRoom3 = {
        title: '방 제목 3',
        gameMode: 'NORMAL',
        maxPlayerCount: '4',
        isWaiting: '1',
        quizSetId: '3',
        quizSetTitle: '즐거운 퀴즈모음3'
      };

      redisMock.keys.mockResolvedValue(mockRoomKeys);
      redisMock.hgetall.mockImplementation(async (key) => {
        if (key === 'Room:123') {
          return mockRoom1;
        }
        if (key === 'Room:456') {
          return mockRoom2;
        }
        if (key === 'Room:789') {
          return mockRoom3;
        }
        return null;
      });
      redisMock.scard.mockResolvedValue(2);

      // When - 첫 페이지 조회
      const firstPageResult = await service.findAllWaitingRooms(undefined, 2);

      // Then
      expect(firstPageResult.roomList).toHaveLength(2);
      expect(firstPageResult.paging.hasNextPage).toBeTruthy();
      expect(firstPageResult.paging.nextCursor).toBe('456');
      expect(firstPageResult.roomList[0].gameId).toBe('789');
      expect(firstPageResult.roomList[1].gameId).toBe('456');

      // When - 두 번째 페이지 조회
      const secondPageResult = await service.findAllWaitingRooms(456, 2);

      // Then
      expect(secondPageResult.roomList).toHaveLength(1);
      expect(secondPageResult.paging.hasNextPage).toBeFalsy();
      expect(secondPageResult.paging.nextCursor).toBeNull();
      expect(secondPageResult.roomList[0].gameId).toBe('123');
    });

    it('cursor가 존재하지 않는 값일 경우 빈 배열을 반환한다', async () => {
      // Given
      const mockRoomKeys = ['Room:123', 'Room:456'];
      redisMock.keys.mockResolvedValue(mockRoomKeys);

      // When
      const result = await service.findAllWaitingRooms(999, 10);

      // Then
      expect(result.roomList).toEqual([]);
      expect(result.paging.hasNextPage).toBeFalsy();
      expect(result.paging.nextCursor).toBeNull();
    });

    it('대기중인 방이 없을 경우 빈 배열을 반환한다', async () => {
      // Given
      redisMock.keys.mockResolvedValue([]);

      // When
      const result = await service.findAllWaitingRooms(undefined, 10);

      // Then
      expect(result.roomList).toEqual([]);
      expect(result.paging.hasNextPage).toBeFalsy();
      expect(result.paging.nextCursor).toBeNull();
    });

    it('모든 방이 대기중이 아닐 경우 빈 배열을 반환한다', async () => {
      // Given
      const mockRoomKeys = ['Room:123', 'Room:456'];
      const mockRoom = {
        title: '방 제목 1',
        gameMode: 'NORMAL',
        maxPlayerCount: '4',
        isWaiting: '0',
        quizSetId: '1',
        quizSetTitle: '즐거운 퀴즈모음1'
      };

      redisMock.keys.mockResolvedValue(mockRoomKeys);
      redisMock.hgetall.mockResolvedValue(mockRoom);

      // When
      const result = await service.findAllWaitingRooms(undefined, 10);

      // Then
      expect(result.roomList).toEqual([]);
      expect(result.paging.hasNextPage).toBeFalsy();
      expect(result.paging.nextCursor).toBeNull();
    });
  });
});
