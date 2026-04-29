import { Injectable } from '@nestjs/common';
import * as promClient from 'prom-client';
import { MetricSnapshot, SystemMetricSnapshot } from './interfaces/metric.interface';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';

@Injectable()
export class MetricService {
  private readonly REDIS_KEYS = {
    IS_COLLECTING: 'metrics:isCollecting',
    COLLECTED_METRICS: 'metrics:collected',
    SYSTEM_SNAPSHOTS: 'metrics:system:snapshots',
    START_SYSTEM_METRICS: 'metrics:system:start'
  };

  private readonly requestCounter: promClient.Counter;
  private readonly responseCounter: promClient.Counter;
  private readonly latencyHistogram: promClient.Histogram;
  private readonly throughputGauge: promClient.Gauge;
  private readonly systemMetrics: {
    cpu: promClient.Gauge;
    memory: promClient.Gauge;
    network: promClient.Gauge;
  };
  private readonly wsConnectedClients: promClient.Gauge;
  private readonly roomPlayerCount: promClient.Gauge;

  constructor(@InjectRedis() private readonly redis: Redis) {
    promClient.collectDefaultMetrics();
    this.requestCounter = new promClient.Counter({
      name: 'socket_requests_total',
      help: 'Total number of socket requests',
      labelNames: ['event', 'status']
    });

    this.responseCounter = new promClient.Counter({
      name: 'socket_responses_total',
      help: 'Total number of socket responses',
      labelNames: ['event', 'status']
    });

    this.latencyHistogram = new promClient.Histogram({
      name: 'socket_latency_seconds',
      help: 'Latency of socket operations in seconds',
      labelNames: ['event', 'operation'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 30]
    });

    this.throughputGauge = new promClient.Gauge({
      name: 'socket_throughput',
      help: 'Number of operations per second',
      labelNames: ['operation']
    });

    this.systemMetrics = {
      cpu: new promClient.Gauge({
        name: 'system_cpu_usage',
        help: 'CPU usage percentage'
      }),
      memory: new promClient.Gauge({
        name: 'system_memory_usage',
        help: 'Memory usage in bytes'
      }),
      network: new promClient.Gauge({
        name: 'system_network_usage',
        help: 'Network usage in bytes'
      })
    };

    this.wsConnectedClients = new promClient.Gauge({
      name: 'websocket_connected_clients',
      help: 'Currently connected WebSocket clients'
    });

    this.roomPlayerCount = new promClient.Gauge({
      name: 'game_room_player_count',
      help: 'Active players per game room',
      labelNames: ['gameId']
    });

    this.startCollectingSystemMetrics();
  }

  setWsClients(count: number) {
    this.wsConnectedClients.set(count);
  }

  setRoomPlayerCount(gameId: string, count: number) {
    this.roomPlayerCount.set({ gameId }, count);
  }

  private async startCollectingSystemMetrics() {
    setInterval(async () => {
      const metrics = await this.getSystemMetrics();

      this.systemMetrics.cpu.set(metrics.cpu);
      this.systemMetrics.memory.set(metrics.memory);

      const isCollecting = await this.isCurrentlyCollecting();
      if (isCollecting) {
        const snapshots = JSON.stringify(metrics);
        await this.redis.rpush(this.REDIS_KEYS.SYSTEM_SNAPSHOTS, snapshots);
      }
    }, 1000);
  }

  private async getSystemMetrics(): Promise<SystemMetricSnapshot> {
    const usage = process.cpuUsage();
    const memoryUsage = process.memoryUsage();

    return {
      cpu: (usage.user + usage.system) / 1e6,
      memory: memoryUsage.heapUsed,
      timestamp: Date.now()
    };
  }

  async startCollecting(): Promise<void> {
    await this.redis.set(this.REDIS_KEYS.IS_COLLECTING, '1');
    await this.redis.del(this.REDIS_KEYS.COLLECTED_METRICS);
    await this.redis.del(this.REDIS_KEYS.SYSTEM_SNAPSHOTS);

    const startMetrics = await this.getSystemMetrics();
    await this.redis.set(this.REDIS_KEYS.START_SYSTEM_METRICS, JSON.stringify(startMetrics));
  }

  async stopCollecting(): Promise<any> {
    await this.redis.set(this.REDIS_KEYS.IS_COLLECTING, '0');

    const collectedMetricsStr = await this.redis.lrange(this.REDIS_KEYS.COLLECTED_METRICS, 0, -1);
    const collectedMetrics = collectedMetricsStr.map((str) => JSON.parse(str));

    const systemSnapshotsStr = await this.redis.lrange(this.REDIS_KEYS.SYSTEM_SNAPSHOTS, 0, -1);
    const systemSnapshots = systemSnapshotsStr.map((str) => JSON.parse(str));

    const startSystemMetricsStr = await this.redis.get(this.REDIS_KEYS.START_SYSTEM_METRICS);
    const startSystemMetrics = startSystemMetricsStr ? JSON.parse(startSystemMetricsStr) : null;

    const applicationStats = this.calculateStats(collectedMetrics);
    const systemStats = this.calculateSystemStats(startSystemMetrics, systemSnapshots);
    const requestThroughput = this.calculateThroughput(collectedMetrics, 'request');
    const responseThroughput = this.calculateThroughput(collectedMetrics, 'response');

    return {
      application: applicationStats,
      system: systemStats,
      throughput: {
        request: requestThroughput,
        response: responseThroughput
      }
    };
  }

  async isCurrentlyCollecting(): Promise<boolean> {
    const status = await this.redis.get(this.REDIS_KEYS.IS_COLLECTING);
    return status === '1';
  }

  recordRequest(event: string, status: 'success' | 'failure') {
    this.requestCounter.labels(event, status).inc();
  }

  recordResponse(event: string, status: 'success' | 'failure') {
    this.responseCounter.labels(event, status).inc();
  }

  async recordLatency(event: string, operation: 'request' | 'response', duration: number) {
    this.latencyHistogram.labels(event, operation).observe(duration / 1000);

    const isCollecting = await this.isCurrentlyCollecting();
    if (isCollecting) {
      const metric: MetricSnapshot = {
        eventType: event,
        operation,
        executionTime: duration,
        timestamp: Date.now()
      };
      await this.redis.rpush(this.REDIS_KEYS.COLLECTED_METRICS, JSON.stringify(metric));
    }
  }

  private calculateStats(collectedMetrics: MetricSnapshot[]) {
    const operationMetrics = {
      request: collectedMetrics.filter((m) => m.operation === 'request'),
      response: collectedMetrics.filter((m) => m.operation === 'response')
    };

    const result = {};

    for (const [operation, metrics] of Object.entries(operationMetrics)) {
      const eventTypes = [...new Set(metrics.map((m) => m.eventType))];
      const allExecutionTimes = metrics.map((m) => m.executionTime).sort((a, b) => a - b);

      const eventStats = {};
      for (const eventType of eventTypes) {
        const eventMetrics = metrics.filter((m) => m.eventType === eventType);
        const executionTimes = eventMetrics.map((m) => m.executionTime).sort((a, b) => a - b);

        eventStats[eventType] = {
          count: eventMetrics.length,
          mean: this.calculateAverage(executionTimes),
          max: Math.max(...executionTimes),
          min: Math.min(...executionTimes),
          p50: this.calculatePercentile(executionTimes, 50),
          p80: this.calculatePercentile(executionTimes, 80),
          p90: this.calculatePercentile(executionTimes, 90),
          p95: this.calculatePercentile(executionTimes, 95),
          p99: this.calculatePercentile(executionTimes, 99)
        };
      }

      result[operation] = {
        summary: {
          totalEvents: metrics.length,
          averageExecutionTime: this.calculateAverage(allExecutionTimes),
          maxExecutionTime: allExecutionTimes.length ? Math.max(...allExecutionTimes) : 0,
          minExecutionTime: allExecutionTimes.length ? Math.min(...allExecutionTimes) : 0,
          p50: this.calculatePercentile(allExecutionTimes, 50),
          p80: this.calculatePercentile(allExecutionTimes, 80),
          p90: this.calculatePercentile(allExecutionTimes, 90),
          p95: this.calculatePercentile(allExecutionTimes, 95),
          p99: this.calculatePercentile(allExecutionTimes, 99)
        },
        eventStats
      };
    }

    return result;
  }

  private calculateSystemStats(
    startSystemMetrics: SystemMetricSnapshot,
    systemSnapshots: SystemMetricSnapshot[]
  ) {
    if (!startSystemMetrics || systemSnapshots.length === 0) {
      return null;
    }

    const endMetrics = systemSnapshots[systemSnapshots.length - 1];

    const cpuValues = systemSnapshots.map((m) => m.cpu);
    const memoryValues = systemSnapshots.map((m) => m.memory);

    return {
      duration: {
        start: new Date(startSystemMetrics.timestamp).toLocaleString('ko-KR'),
        end: new Date(endMetrics.timestamp).toLocaleString('ko-KR'),
        seconds: `${(endMetrics.timestamp - startSystemMetrics.timestamp) / 1000}s`
      }
      // cpu: {
      //   start: startSystemMetrics.cpu,
      //   end: endMetrics.cpu,
      //   min: Math.min(...cpuValues),
      //   max: Math.max(...cpuValues),
      //   mean: this.calculateAverage(cpuValues),
      //   p95: this.calculatePercentile(cpuValues.sort((a, b) => a - b), 95)
      // },
      // memory: {
      //   start: startSystemMetrics.memory,
      //   end: endMetrics.memory,
      //   min: Math.min(...memoryValues),
      //   max: Math.max(...memoryValues),
      //   mean: this.calculateAverage(memoryValues),
      //   p95: this.calculatePercentile(memoryValues.sort((a, b) => a - b), 95)
      // }
    };
  }

  private calculateThroughput(
    collectedMetrics: MetricSnapshot[],
    operation: 'request' | 'response'
  ) {
    const metrics = collectedMetrics.filter((m) => m.operation === operation);

    if (metrics.length === 0) {
      return {
        avgThroughput: 0,
        peakThroughput: 0,
        durationSeconds: 0
      };
    }

    const startTime = Math.min(...metrics.map((m) => m.timestamp));
    const endTime = Math.max(...metrics.map((m) => m.timestamp));
    const durationSeconds = Math.max((endTime - startTime) / 1000, 1);

    const timeWindows = new Map<number, number>();
    metrics.forEach((metric) => {
      const windowKey = Math.floor((metric.timestamp - startTime) / 1000);
      timeWindows.set(windowKey, (timeWindows.get(windowKey) || 0) + 1);
    });

    const avgThroughput = metrics.length / durationSeconds;
    const peakThroughput = timeWindows.size > 0 ? Math.max(...timeWindows.values()) : 0;

    return {
      avgThroughput: Number(avgThroughput.toFixed(2)),
      peakThroughput,
      durationSeconds: Number(durationSeconds.toFixed(2))
    };
  }

  private calculatePercentile(sortedValues: number[], percentile: number): number {
    if (sortedValues.length === 0) {
      return 0;
    }
    const index = Math.ceil((percentile / 100) * sortedValues.length) - 1;
    return sortedValues[index];
  }

  private calculateAverage(values: number[]): number {
    if (values.length === 0) {
      return 0;
    }
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }
}
