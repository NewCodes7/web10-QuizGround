import { ConsoleLogger } from '@nestjs/common';

/**
 * NestJS 기본 ConsoleLogger의 타임스탬프를 KST(UTC+9) + 밀리초 형식으로 교체.
 * 예) 2026-04-14 15:32:07.123 +09:00
 */
export class KstLogger extends ConsoleLogger {
  protected getTimestamp(): string {
    const now = new Date();
    // UTC 기준 ms에 9시간(32400000ms)을 더해 KST offset 적용
    const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);

    const yyyy = kst.getUTCFullYear();
    const MM = String(kst.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(kst.getUTCDate()).padStart(2, '0');
    const hh = String(kst.getUTCHours()).padStart(2, '0');
    const mm = String(kst.getUTCMinutes()).padStart(2, '0');
    const ss = String(kst.getUTCSeconds()).padStart(2, '0');
    const ms = String(kst.getUTCMilliseconds()).padStart(3, '0');

    return `${yyyy}-${MM}-${dd} ${hh}:${mm}:${ss}.${ms} +09:00`;
  }
}
