import { Column, Entity, Index } from 'typeorm';
import { BaseModel } from '../../common/entity/base.entity';

@Entity('chat_message')
@Index('uq_chat_stream_entry_id', ['streamEntryId'], { unique: true })
export class ChatMessageModel extends BaseModel {
  /** 게임방 PIN (6자리) */
  @Column({ name: 'game_id', type: 'varchar', length: 6 })
  gameId: string;

  /**
   * Redis Stream entry ID (e.g. "1713000000000-0").
   * unique constraint로 중복 저장 방지:
   * insert 성공 후 cursor 갱신이 실패해 다음 주기에 재시도하더라도
   * 동일 stream entry ID가 있으면 INSERT IGNORE로 건너뛴다.
   */
  @Column({ name: 'stream_entry_id', type: 'varchar', length: 32 })
  streamEntryId: string;

  /** 발신 플레이어 ID (UUID) */
  @Column({ name: 'player_id', type: 'varchar', length: 36 })
  playerId: string;

  /** 발신 플레이어 닉네임 */
  @Column({ name: 'player_name', type: 'varchar', length: 100 })
  playerName: string;

  /** 채팅 메시지 본문 */
  @Column({ type: 'text' })
  message: string;

  /** 발신 시점의 생존 상태 (서바이벌 모드) */
  @Column({ name: 'is_alive', type: 'boolean' })
  isAlive: boolean;

  /** 클라이언트가 메시지를 보낸 시각 */
  @Column({ name: 'sent_at', type: 'timestamp' })
  sentAt: Date;
}
