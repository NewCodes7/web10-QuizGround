import { Packr, Unpackr } from 'msgpackr';

export const protocol = 5;

const packr = new Packr({ useRecords: false });
const unpackr = new Unpackr({ useRecords: false });

type Listener = (...args: unknown[]) => void;

class SimpleEmitter {
  private _events: Map<string, Listener[]> = new Map();

  on(event: string, fn: Listener): this {
    const arr = this._events.get(event) ?? [];
    arr.push(fn);
    this._events.set(event, arr);
    return this;
  }

  emit(event: string, ...args: unknown[]): this {
    (this._events.get(event) ?? []).forEach((fn) => fn(...args));
    return this;
  }

  off(event: string, fn: Listener): this {
    const arr = this._events.get(event) ?? [];
    this._events.set(event, arr.filter((l) => l !== fn));
    return this;
  }
}

export class Encoder {
  encode(packet: unknown): Buffer[] {
    return [packr.pack(packet)];
  }
}

export class Decoder extends SimpleEmitter {
  add(chunk: ArrayBuffer | Buffer): void {
    const buf = chunk instanceof ArrayBuffer ? Buffer.from(chunk) : chunk;
    const packet = unpackr.unpack(buf);
    // socket.io-msgpack-parser의 checkPacket(type/nsp/data 유효성 검사)을 의도적으로 생략.
    // 유효하지 않은 패킷은 socket.io-client 내부에서 처리되며, 검사 비용을 줄이기 위한 선택.
    this.emit('decoded', packet);
  }

  destroy(): void {}
}
