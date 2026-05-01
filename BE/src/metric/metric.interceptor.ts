import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { MetricService } from './metric.service';
import SocketEvents from '../common/constants/socket-events';

@Injectable()
export class MetricInterceptor implements NestInterceptor {
  private readonly eventPatterns = Object.values(SocketEvents);

  constructor(private metricService: MetricService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const startedAt = process.hrtime();
    const ctx = context.switchToWs();
    const event = ctx.getPattern();

    if (!this.eventPatterns.includes(event as any)) {
      return next.handle();
    }

    return next.handle().pipe(
      tap({
        next: async () => {
          const endedAt = process.hrtime(startedAt);
          const delta = endedAt[0] * 1e9 + endedAt[1];
          const executionTime = delta / 1e6;

          this.metricService.recordRequest(event, 'success');
          this.metricService.recordLatency(event, 'request', executionTime);
        },
        error: () => {
          this.metricService.recordRequest(event, 'failure');
        }
      })
    );
  }
}
