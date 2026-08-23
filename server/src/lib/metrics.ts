interface Metrics {
  startedAt: number;
  requestsTotal: number;
  responses5xx: number;
  authFailures: number;
  remindersSent: number;
  remindersFailed: number;
  pushesSent: number;
}

export const metrics: Metrics = {
  startedAt: Date.now(),
  requestsTotal: 0,
  responses5xx: 0,
  authFailures: 0,
  remindersSent: 0,
  remindersFailed: 0,
  pushesSent: 0
};

export function snapshotMetrics(): Metrics & { uptimeSeconds: number; memoryMb: number } {
  const memory = process.memoryUsage();
  return {
    ...metrics,
    uptimeSeconds: Math.floor((Date.now() - metrics.startedAt) / 1000),
    memoryMb: Math.round(memory.rss / (1024 * 1024))
  };
}
