import { Module, Global } from '@nestjs/common';
import { MetricService } from './metric.service';
import { MetricController } from './metric.controller';
import { MetricInterceptor } from './metric.interceptor';

@Global()
@Module({
  controllers: [MetricController],
  providers: [MetricService, MetricInterceptor],
  exports: [MetricService, MetricInterceptor]
})
export class MetricModule {}
