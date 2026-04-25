import Pyroscope from '@pyroscope/nodejs';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';
import { GameActivityInterceptor } from './game/middleware/game-activity.interceptor';
import { KstLogger } from './common/logger/kst.logger';

if (process.env.PYROSCOPE_SERVER_URL) {
  Pyroscope.init({
    serverAddress: process.env.PYROSCOPE_SERVER_URL,
    appName: 'quizground.was',
    tags: { instance: process.env.PYROSCOPE_INSTANCE ?? process.env.HOSTNAME ?? 'unknown' }
  });
  Pyroscope.start();
}

async function bootstrap() {
  const logLevels: Array<'debug' | 'verbose' | 'log' | 'warn' | 'error' | 'fatal'> = process.env
    .DEV
    ? ['debug', 'verbose', 'log', 'warn', 'error', 'fatal']
    : ['log', 'warn', 'error', 'fatal'];
  const app = await NestFactory.create(AppModule, {
    logger: new KstLogger(undefined, { logLevels })
  });
  app.enableCors();

  // 전역 인터셉터로 등록
  app.useGlobalInterceptors(app.get(GameActivityInterceptor));

  const port = process.env.WAS_PORT || 3000;
  await app.listen(port);
  Logger.log(`Application running on port ${port}`);
}

bootstrap();
