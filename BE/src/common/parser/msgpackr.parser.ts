import { EventEmitter } from 'events';
import { Packr, Unpackr } from 'msgpackr';

export const protocol = 5;

const packr = new Packr({ useRecords: false });
packr.useBuffer(Buffer.allocUnsafe(2 * 1024 * 1024));
const unpackr = new Unpackr({ useRecords: false });

export class Encoder {
  encode(packet: unknown): Buffer[] {
    // useBuffer() 사용 시 pack()은 arena의 subarray를 반환하므로, 다음 호출 전에 복사.
    return [Buffer.from(packr.pack(packet))];
  }
}

export class Decoder extends EventEmitter {
  add(chunk: Buffer): void {
    const packet = unpackr.unpack(chunk);
    // socket.io-msgpack-parser의 checkPacket(type/nsp/data 유효성 검사)을 의도적으로 생략.
    // 유효하지 않은 패킷은 socket.io 내부에서 처리되며, 검사 비용을 줄이기 위한 선택.
    this.emit('decoded', packet);
  }

  destroy(): void {}
}
