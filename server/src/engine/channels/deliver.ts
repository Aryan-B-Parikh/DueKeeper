import type { RawMail } from './emailChannel';
import { formatOffsetLabel } from '../../lib/time';

export class PermanentDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentDeliveryError';
  }
}

export interface OutboxPayload {
  deliveryId: string;
  eventId: string;
  userId: string;
  channel: 'email' | 'in_app';
  offsetSeconds: number;
  scheduledFor: string;
}

export interface ResolvedEvent {
  title: string;
  dueAt: string;
  timezone: string;
}

/**
 * In-app delivery — enforces `idempotencyKey: reminder:<deliveryId>` so
 * worker retries (lease reclaim, crash) cannot create duplicate notification rows.
 */
export async function deliverInApp(payload: OutboxPayload, event: ResolvedEvent): Promise<void> {
  const { notifyEverywhere } = await import('../notifier');
  notifyEverywhere(
    payload.userId,
    'reminder',
    `${formatOffsetLabel(payload.offsetSeconds)}: ${event.title}`,
    `Your ${event.title} is due at ${new Date(event.dueAt).toISOString().slice(0, 16).replace('T', ' ')} UTC.`,
    {
      eventId: payload.eventId,
      idempotencyKey: `reminder:${payload.deliveryId}`
    }
  );
}

export async function deliverEmail(
  payload: OutboxPayload,
  event: ResolvedEvent,
  sendRaw: (mail: RawMail) => Promise<void>,
  recipientEmail: string
): Promise<void> {
  if (!recipientEmail) {
    throw new PermanentDeliveryError('Recipient has no email address');
  }
  await sendRaw({
    to: recipientEmail,
    subject: `DueKeeper reminder: ${event.title}`,
    // Deterministic key so a retried send is deduplicated by the provider
    // rather than delivered twice.
    idempotencyKey: `reminder-${payload.deliveryId}`,
    text: [
      `Reminder: "${event.title}"`,
      ``,
      `Due at: ${new Date(event.dueAt).toUTCString()}`,
      `That is ${formatOffsetLabel(payload.offsetSeconds)} from now.`,
      ``,
      `Open DueKeeper to review or snooze this deadline.`
    ].join('\n')
  });
}
