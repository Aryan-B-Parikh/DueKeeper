interface Metrics {
  startedAt: number;
  requestsTotal: number;
  responses5xx: number;
  authFailures: number;
  remindersSent: number;
  remindersFailed: number;
  pushesSent: number;
  pushesFailed: number;
  /** Jobs re-queued because their worker died holding the lease. A non-zero and
   *  climbing value means the process is crashing mid-delivery. */
  outboxReclaimed: number;
  /** Jobs abandoned for good. Every one of these is a reminder a user never
   *  received, so this is the number worth alerting on. */
  outboxDeadLettered: number;
  /** Pending deliveries cancelled because the event moved or was completed. */
  deliveriesReconciled: number;
  /** Engine ticks that arrived while the previous cycle was still running and
   *  were folded into a catch-up cycle. Steadily climbing means a tick routinely
   *  outlasts its interval, so the effective cadence is worse than configured. */
  engineTicksCoalesced: number;
  /** Unhandled rejections plus uncaught exceptions. Any non-zero value is a bug
   *  that escaped every `try`; the log line carries the detail. */
  unhandledErrors: number;
}

export const metrics: Metrics = {
  startedAt: Date.now(),
  requestsTotal: 0,
  responses5xx: 0,
  authFailures: 0,
  remindersSent: 0,
  remindersFailed: 0,
  pushesSent: 0,
  pushesFailed: 0,
  outboxReclaimed: 0,
  outboxDeadLettered: 0,
  deliveriesReconciled: 0,
  engineTicksCoalesced: 0,
  unhandledErrors: 0
};

export function snapshotMetrics(): Metrics & { uptimeSeconds: number; memoryMb: number } {
  const memory = process.memoryUsage();
  return {
    ...metrics,
    uptimeSeconds: Math.floor((Date.now() - metrics.startedAt) / 1000),
    memoryMb: Math.round(memory.rss / (1024 * 1024))
  };
}
