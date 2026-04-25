import * as pprof from '@datadog/pprof';
import { createServer } from 'http';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';
import { GameActivityInterceptor } from './game/middleware/game-activity.interceptor';
import { KstLogger } from './common/logger/kst.logger';

const pprofPort = process.env.PPROF_PORT ? parseInt(process.env.PPROF_PORT, 10) : null;
if (pprofPort) {
  pprof.heap.start(512 * 1024, 64);
  createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    try {
      if (url.pathname === '/debug/pprof/profile') {
        const seconds = parseInt(url.searchParams.get('seconds') ?? '15', 10);
        const profile = await pprof.time.profile({ durationMillis: seconds * 1000 });
        const buf = await pprof.encode(profile);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(buf);
      } else if (url.pathname === '/debug/pprof/heap') {
        const profile = pprof.heap.profile();
        const buf = await pprof.encode(profile);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(buf);
      } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('/debug/pprof/profile?seconds=N\n/debug/pprof/heap\n');
      }
    } catch (err) {
      res.writeHead(500);
      res.end(String(err));
    }
  }).listen(pprofPort, '0.0.0.0', () => {
    Logger.log(`pprof server :${pprofPort}`);
  });
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
