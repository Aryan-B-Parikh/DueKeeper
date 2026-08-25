import { metrics, snapshotMetrics } from './metrics';
import { outboxQueueDepth } from '../engine/outbox';

export function renderPrometheus(): string {
  const snap = snapshotMetrics();
  const q = (() => { try { return outboxQueueDepth(); } catch { return { pending: 0, processing: 0, failed: 0, claimable: 0, oldestClaimableAgeSeconds: null }; } })();
  const lines: string[] = [];
  const g = (name: string, help: string, value: number | null) => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} gauge`);
    lines.push(`${name} ${value ?? 0}`);
  };
  const c = (name: string, help: string, value: number) => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} counter`);
    lines.push(`${name} ${value}`);
  };
  c('duekeeper_requests_total', 'Total HTTP requests', snap.requestsTotal);
  c('duekeeper_responses_5xx_total', 'Total 5xx responses', snap.responses5xx);
  c('duekeeper_auth_failures_total', 'Total 401/403', snap.authFailures);
  c('duekeeper_reminders_sent_total', 'Reminders sent', snap.remindersSent);
  c('duekeeper_reminders_failed_total', 'Reminders failed', snap.remindersFailed);
  c('duekeeper_pushes_sent_total', 'Pushes sent', snap.pushesSent);
  c('duekeeper_pushes_failed_total', 'Pushes failed', snap.pushesFailed);
  c('duekeeper_outbox_reclaimed_total', 'Outbox reclaimed (lease expired)', snap.outboxReclaimed);
  c('duekeeper_outbox_deadlettered_total', 'Outbox dead-lettered (user never got reminder)', snap.outboxDeadLettered);
  c('duekeeper_deliveries_reconciled_total', 'Deliveries reconciled (moved/cancelled)', snap.deliveriesReconciled);
  c('duekeeper_engine_ticks_coalesced_total', 'Engine ticks coalesced (overload)', snap.engineTicksCoalesced);
  c('duekeeper_unhandled_errors_total', 'Unhandled rejections/exceptions', snap.unhandledErrors);
  g('duekeeper_uptime_seconds', 'Uptime seconds', snap.uptimeSeconds);
  g('duekeeper_memory_rss_mb', 'RSS MB', snap.memoryMb);
  g('duekeeper_outbox_pending', 'Outbox pending', q.pending);
  g('duekeeper_outbox_processing', 'Outbox processing', q.processing);
  g('duekeeper_outbox_failed', 'Outbox failed', q.failed);
  g('duekeeper_outbox_claimable', 'Outbox claimable (due now)', q.claimable);
  g('duekeeper_outbox_oldest_claimable_age_seconds', 'Oldest claimable age seconds', q.oldestClaimableAgeSeconds);
  // For PG, add DB pool metrics would go here (pgPool.totalCount etc.)
  return lines.join('\n') + '\n';
}
