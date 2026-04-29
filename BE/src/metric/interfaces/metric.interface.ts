export interface MetricSnapshot {
  eventType: string;
  operation: string;
  executionTime: number;
  timestamp: number;
}

export interface SystemMetricSnapshot {
  cpu: number;
  memory: number;
  timestamp: number;
}
