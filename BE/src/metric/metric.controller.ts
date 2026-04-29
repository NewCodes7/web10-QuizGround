import { Controller, Post, Get } from '@nestjs/common';
import { MetricService } from './metric.service';
import * as promClient from 'prom-client';

@Controller('api/metric')
export class MetricController {
  constructor(private metricService: MetricService) {}

  @Post('start')
  async startMetric() {
    const isCollecting = await this.metricService.isCurrentlyCollecting();
    if (isCollecting) {
      return { success: false, message: 'Already collecting metrics' };
    }

    await this.metricService.startCollecting();
    return { success: true, message: 'Started collecting metrics' };
  }

  @Post('stop')
  async stopMetric() {
    const stats = await this.metricService.stopCollecting();
    return {
      success: true,
      ...stats
    };
  }

  @Get('status')
  async getStatus() {
    const isCollecting = await this.metricService.isCurrentlyCollecting();
    return { collecting: isCollecting };
  }

  @Get('prometheus')
  async getPrometheusMetrics(): Promise<string> {
    return await promClient.register.metrics();
  }
}
