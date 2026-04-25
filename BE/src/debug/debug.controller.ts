import {
  Controller,
  Get,
  Query,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Response } from 'express';
import { Session } from 'node:inspector/promises';
import * as v8 from 'node:v8';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

@Controller('api/debug')
export class DebugController {
  /**
   * CPU 프로파일 수집 (V8 .cpuprofile)
   * 사용: curl "http://node1:3000/api/debug/profile?token=SECRET&seconds=30" -o cpu.cpuprofile
   * 분석: speedscope.app 또는 Chrome DevTools > Performance > Import
   */
  @Get('profile')
  async cpuProfile(
    @Query('token') token: string,
    @Query('seconds') seconds = '30',
    @Res() res: Response,
  ) {
    this.validateToken(token);

    const durationMs = Math.min(Math.max(parseInt(seconds, 10) || 30, 5), 60) * 1000;
    const session = new Session();
    session.connect();

    try {
      await session.post('Profiler.enable');
      await session.post('Profiler.start');
      await new Promise<void>(resolve => setTimeout(resolve, durationMs));
      const { profile } = await session.post('Profiler.stop');

      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="cpu-${Date.now()}.cpuprofile"`);
      res.send(JSON.stringify(profile));
    } finally {
      session.disconnect();
    }
  }

  /**
   * 힙 스냅샷 수집 (V8 .heapsnapshot)
   * 사용: curl "http://node1:3000/api/debug/heap?token=SECRET" -o heap.heapsnapshot
   * 분석: Chrome DevTools > Memory > Load
   */
  @Get('heap')
  heapSnapshot(@Query('token') token: string, @Res() res: Response) {
    this.validateToken(token);

    const filePath = v8.writeHeapSnapshot(os.tmpdir());
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);
    res.sendFile(filePath, err => {
      fs.unlink(filePath, () => {});
      if (err && !res.headersSent) res.status(500).end();
    });
  }

  private validateToken(token: string) {
    const expected = process.env.DEBUG_TOKEN;
    if (!expected) throw new ServiceUnavailableException('DEBUG_TOKEN not configured');
    if (token !== expected) throw new UnauthorizedException();
  }
}
