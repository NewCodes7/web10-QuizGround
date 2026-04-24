import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateChatMessageTable1745500000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS \`chat_message\` (
        \`id\` int NOT NULL AUTO_INCREMENT,
        \`createdAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        \`updatedAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        \`deletedAt\` datetime(6) NULL,
        \`game_id\` varchar(6) NOT NULL,
        \`stream_entry_id\` varchar(32) NOT NULL,
        \`player_id\` varchar(36) NOT NULL,
        \`player_name\` varchar(100) NOT NULL,
        \`message\` text NOT NULL,
        \`is_alive\` tinyint NOT NULL,
        \`sent_at\` timestamp NOT NULL,
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uq_chat_stream_entry_id\` (\`stream_entry_id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS \`chat_message\``);
  }
}
