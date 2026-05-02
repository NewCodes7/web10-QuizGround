import { Encoder, Decoder, protocol } from './msgpackr.parser';

describe('msgpackr parser', () => {
  describe('protocol', () => {
    it('socket.io 프로토콜 버전 5를 내보낸다', () => {
      expect(protocol).toBe(5);
    });
  });

  describe('Encoder', () => {
    let encoder: Encoder;

    beforeEach(() => {
      encoder = new Encoder();
    });

    it('encode()는 Buffer 배열을 반환한다', () => {
      const result = encoder.encode({ type: 2, nsp: '/game', data: ['test'] });
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(Buffer);
    });

    it('일반적인 socket.io EVENT 패킷을 인코딩한다', () => {
      const packet = { type: 2, nsp: '/game', data: ['updatePosition', { x: 0.5, y: 0.3 }] };
      const result = encoder.encode(packet);
      expect(result[0].length).toBeGreaterThan(0);
    });

    it('빈 데이터 배열을 포함한 패킷을 인코딩한다', () => {
      const packet = { type: 2, nsp: '/', data: [] };
      const result = encoder.encode(packet);
      expect(result[0]).toBeInstanceOf(Buffer);
    });
  });

  describe('Decoder', () => {
    let decoder: Decoder;

    beforeEach(() => {
      decoder = new Decoder();
    });

    afterEach(() => {
      decoder.removeAllListeners();
    });

    it('add() 호출 시 decoded 이벤트를 발생시킨다', (done) => {
      const encoder = new Encoder();
      const packet = { type: 2, nsp: '/game', data: ['chat', { message: 'hello' }] };
      const [encoded] = encoder.encode(packet);

      decoder.on('decoded', (decoded) => {
        expect(decoded).toEqual(packet);
        done();
      });

      decoder.add(encoded);
    });

    it('destroy()를 호출해도 에러가 발생하지 않는다', () => {
      expect(() => decoder.destroy()).not.toThrow();
    });

    it('removeListener로 decoded 리스너를 제거할 수 있다', () => {
      const encoder = new Encoder();
      const packet = { type: 2, nsp: '/', data: ['event'] };
      const [encoded] = encoder.encode(packet);

      const listener = jest.fn();
      decoder.on('decoded', listener);
      decoder.removeListener('decoded', listener);
      decoder.add(encoded);

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('Encoder + Decoder 라운드트립', () => {
    it('인코딩 후 디코딩하면 원본 패킷과 동일하다', (done) => {
      const encoder = new Encoder();
      const decoder = new Decoder();

      const original = {
        type: 2,
        nsp: '/game',
        data: ['startGame', { quizSetId: 1, players: ['a', 'b'] }],
      };

      decoder.on('decoded', (decoded) => {
        expect(decoded).toEqual(original);
        done();
      });

      const [encoded] = encoder.encode(original);
      decoder.add(encoded);
    });

    it('숫자, 문자열, boolean, null이 포함된 복합 패킷을 처리한다', (done) => {
      const encoder = new Encoder();
      const decoder = new Decoder();

      const original = {
        type: 2,
        nsp: '/game',
        data: [
          'updateState',
          {
            score: 100,
            name: '플레이어',
            alive: true,
            eliminated: null,
            position: { x: 0.123, y: 0.456 },
          },
        ],
      };

      decoder.on('decoded', (decoded) => {
        expect(decoded).toEqual(original);
        done();
      });

      decoder.add(encoder.encode(original)[0]);
    });

    it('빈 nsp를 가진 CONNECT 패킷(type 0)을 처리한다', (done) => {
      const encoder = new Encoder();
      const decoder = new Decoder();
      const original = { type: 0, nsp: '/game', data: undefined };

      decoder.on('decoded', (decoded) => {
        expect(decoded).toEqual(original);
        done();
      });

      decoder.add(encoder.encode(original)[0]);
    });
  });
});
