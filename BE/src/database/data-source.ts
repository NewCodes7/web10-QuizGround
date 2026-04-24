import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
import { QuizSetModel } from '../quiz-set/entities/quiz-set.entity';
import { QuizModel } from '../quiz-set/entities/quiz.entity';
import { QuizChoiceModel } from '../quiz-set/entities/quiz-choice.entity';
import { UserModel } from '../user/entities/user.entity';
import { UserQuizArchiveModel } from '../user/entities/user-quiz-archive.entity';
import { ChatMessageModel } from '../game/entities/chat-message.entity';

dotenv.config({ path: '../.env' });

export const AppDataSource = new DataSource({
  type: 'mysql',
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  username: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWD || 'test',
  database: process.env.DB_NAME || 'test_db',
  entities: [QuizSetModel, QuizModel, QuizChoiceModel, UserModel, UserQuizArchiveModel, ChatMessageModel],
  migrations: ['src/database/migrations/*.ts'],
  migrationsTableName: 'typeorm_migrations',
});
