# socket.io 직렬화 파서 대안 분석

> 작성일: 2026-05-02  
> 배경: `socket.io-msgpack-parser` v3.0.2가 2022-11-14 이후 유지보수 중단됨.  
> 내부 의존 라이브러리 `notepack.io`의 동적 버퍼 할당이 GC 압력을 높이는 문제 확인 (CPU 프로파일 상 GC 17.1% → 21.9%).

---

## 현재 상황

| 항목 | 내용 |
|------|------|
| 사용 파서 | `socket.io-msgpack-parser` v3.0.2 |
| 내부 구현 | `notepack.io` v2.2.0 |
| 마지막 릴리즈 | 2022-11-14 (약 3.5년 전) |
| 핵심 문제 | `encode()` 호출마다 `Buffer.allocUnsafe(size)` 신규 할당 → GC 압력 |

`socket.io-msgpack-parser`는 socketio 공식 org 소속이지만 사실상 유지보수 중단 상태.  
내부에서 그대로 `notepack.io`를 사용하므로, 파서 래퍼만 교체해도 notepack.io를 직접 쓰면 동일 문제가 남는다.

---

## 대안 비교표

| 대안 | 유지보수 | 최신 릴리즈 | GC 최적화 | socket.io 파서 래퍼 | 브라우저 지원 | 전환 난이도 |
|------|---------|------------|-----------|-------------------|--------------|------------|
| **현재: socket.io-msgpack-parser** (notepack.io) | 중단 (2022) | 3.0.2 / 2022-11 | 없음 | 기존 사용 중 | O | — |
| **msgpackr** | **매우 활발** | **1.11.10 / 2026-04-21** | `Packr` 인스턴스 재사용, `useBuffer()` arena 할당 | 직접 구현 (~60줄) | O | 중 |
| **@msgpack/msgpack** | 활발 | 3.1.3 / 2025-12 | `Encoder` 재사용 (~20% 향상) | 직접 구현 (~60줄) | O | 중 |
| **cbor-x** | 활발(라이브러리), 중단(파서 래퍼) | 최신 활발 | msgpackr 유사 | 직접 구현 필요 | O | 중~상 |
| **@socket.io/devalue-parser** | 있음 (2024) | 0.1.0 / 2024-03 | N/A (string 기반) | 즉시 사용 가능 | O | 하 |
| **msgpack-lite** | **중단 (archived)** | — | 없음 | — | O | 고려 불필요 |
| **raw WebSocket 전환** | — | — | 완전 제어 | 불필요 | 직접 구현 | **매우 상** |
| **FlatBuffers / Protobuf** | 활발 | — | 우수 | 직접 구현 | 스키마 필요 | **매우 상** |

---

## 각 대안 상세

### msgpackr (최종 채택)

- 현재 가장 활발하게 유지되는 MessagePack 구현체 (2026-04-21 최신 릴리즈)
- `Packr` / `Unpackr` 인스턴스를 싱글턴으로 재사용 → 내부 상태 재활용, 매번 초기화 비용 없음
- `useRecords: false` 설정 시 schema-based 압축 없이 일반 msgpack 호환 포맷 사용
- 벤치마크 기준 notepack.io 대비 인코딩 +10%, 대형 데이터 +18%
- 선택적 native addon으로 Node.js 서버 측 추가 가속 가능
- 단점: socket.io custom parser 래퍼 직접 작성 필요 (약 60줄, 단순한 구조)

### @msgpack/msgpack

- MessagePack 공식 JS 구현 (msgpack.org 인증), spec 완전 준수
- TypeScript 네이티브, 브라우저 지원 최우수
- `Encoder` 인스턴스 재사용 시 내부 버퍼 재활용 가능하나 명시적 풀링 API 없음
- msgpackr 대비 GC 개선 효과가 덜 확실함

### @socket.io/devalue-parser

- Date, Map, Set, undefined 등 JS 타입 직렬화 목적 — 바이너리 압축이 아님
- 현재 문제(GC, 페이로드 크기)와 무관. 고려 대상 아님

### raw WebSocket 전환

- Socket.IO가 제공하는 namespace, room, reconnect, ack, Redis pub/sub 연동을 전부 직접 구현해야 함
- 현재 아키텍처(분산 WAS + Redis pub/sub)에서 ROI 없음. 고려 대상 아님

---

## socket.io v4 custom parser API

socket.io custom parser가 구현해야 하는 인터페이스:

```typescript
// Encoder: 패킷 → 바이너리/문자열 배열
class Encoder {
  encode(packet: Packet): (string | Buffer)[]
}

// Decoder: EventEmitter를 상속, "decoded" 이벤트 발생
class Decoder extends EventEmitter {
  add(chunk: string | Buffer): void  // 청크 수신 → 파싱 → emit("decoded", packet)
  destroy(): void                    // 내부 버퍼 정리
}

// Packet 구조
interface Packet {
  type: number;   // 0=CONNECT, 1=DISCONNECT, 2=EVENT, 3=ACK, 4=CONNECT_ERROR
  nsp: string;
  data?: unknown;
  id?: number;
}
```

---

## 교체 결과 (2026-05-02)

`msgpackr` v1.11.10 기반 커스텀 파서 직접 구현으로 `socket.io-msgpack-parser` + `notepack.io` 교체 완료.

구현 파일:
- BE: `BE/src/common/parser/msgpackr.parser.ts`
- FE: `FE/src/api/socket/msgpackr.parser.ts`
