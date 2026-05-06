import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';
import { KstLogger } from './common/logger/kst.logger';
import { HeapSnapshotService } from './debug/heap-snapshot.service';

async function bootstrap() {
  const logLevels: Array<'debug' | 'verbose' | 'log' | 'warn' | 'error' | 'fatal'> = process.env
    .DEV
    ? ['debug', 'verbose', 'log', 'warn', 'error', 'fatal']
    : ['log', 'warn', 'error', 'fatal'];
  const app = await NestFactory.create(AppModule, {
    logger: new KstLogger(undefined, { logLevels })
  });
  app.enableCors({
    origin: process.env.CORS_ORIGIN
      ? process.env.CORS_ORIGIN.split(',').map((o) => o.trim())
      : true,
    credentials: true
  });
  app.enableShutdownHooks();

  const port = process.env.WAS_PORT || 1027;
  await app.listen(port);
  Logger.log(`Application running on port ${port}`);

  const heapService = app.get(HeapSnapshotService);
  process.on('SIGUSR2', () => {
    const snap = heapService.takeSnapshot('sigusr2');
    Logger.log(`[HeapSnapshot] SIGUSR2 → ${snap.filePath} (id=${snap.id}, ${(snap.sizeBytes / 1048576).toFixed(1)} MB)`);
  });
}

bootstrap();
