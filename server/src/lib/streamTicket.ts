import { createHash, randomBytes } from 'crypto';
import { queryOne } from '../db/database';

/**
 * Short-lived, single-use tickets for authenticating an SSE stream.
 *
 * Browser `EventSource` cannot set request headers, so the only way a plain
 * `new EventSource(url)` can authenticate is through the URL. Putting the access
 * JWT there — as this app used to — leaks a full-privilege, still-valid
 * credential into access logs, proxy logs, `Referer` headers and browser
 * history, where it can be replayed for the rest of its lifetime.
 *
 * A ticket is the standard mitigation: the client asks an authenticated endpoint
 * for one, then spends it on the stream URL. If it leaks, an attacker gets a
 * value that is already consumed, expires in 30 seconds, and grants nothing but
 * a read-only notification stream.
 */
const TTL_MS = 30_000;

/**
 * Memory bound. Tickets are tiny and expire quickly, so this is only reached by
 * a client (or attacker) minting them in a loop; the oldest are evicted first.
 */
const MAX_TICKETS = 10_000;

const MAX_TICKET_CHARS = 128;

interface TicketEntry {
  userId: string;
  tokenVersion: number;
  expiresAt: number;
}

/** Keyed by digest, so a heap dump or debugger view holds no spendable ticket. */
const tickets = new Map<string, TicketEntry>();

function digest(ticket: string): string {
  return createHash('sha256').update(ticket).digest('hex');
}

function sweep(now: number): void {
  for (const [key, entry] of tickets) {
    if (entry.expiresAt <= now) tickets.delete(key);
  }
}

export interface IssuedStreamTicket {
  ticket: string;
  expiresInSeconds: number;
}

export function issueStreamTicket(userId: string, tokenVersion?: number): IssuedStreamTicket {
  const now = Date.now();
  sweep(now);
  while (tickets.size >= MAX_TICKETS) {
    const oldest = tickets.keys().next();
    if (oldest.done) break;
    tickets.delete(oldest.value);
  }
  // Capture token_version so a ticket minted just before revoke-all cannot outlive the revocation.
  // If caller did not supply it, read it — cheap indexed PK lookup, in-memory ticket is already small.
  let version = tokenVersion;
  if (version === undefined) {
    try {
      const row = queryOne<{ token_version: number }>('SELECT token_version FROM users WHERE id = ?', userId);
      version = row ? Number(row.token_version ?? 0) : 0;
    } catch {
      version = 0;
    }
  }
  const ticket = randomBytes(32).toString('base64url');
  tickets.set(digest(ticket), { userId, tokenVersion: Number(version ?? 0), expiresAt: now + TTL_MS });
  return { ticket, expiresInSeconds: Math.floor(TTL_MS / 1000) };
}

/**
 * Returns the user the ticket belonged to, or null if it is unknown, expired,
 * already spent, or the account's `token_version` has moved since the ticket
 * was minted (e.g. password change / revoke-all). Deletion happens before the
 * expiry check so a replay can never succeed.
 */
export function consumeStreamTicket(ticket: string): string | null {
  if (!ticket || ticket.length > MAX_TICKET_CHARS) return null;
  const key = digest(ticket);
  const entry = tickets.get(key);
  if (!entry) return null;
  tickets.delete(key);
  if (entry.expiresAt <= Date.now()) return null;
  try {
    const row = queryOne<{ token_version: number }>('SELECT token_version FROM users WHERE id = ?', entry.userId);
    const current = row ? Number(row.token_version ?? 0) : 0;
    if (current !== Number(entry.tokenVersion ?? 0)) return null;
  } catch {
    // DB hiccup — fail open for stream, Bearer path still enforces revocation
  }
  return entry.userId;
}

/** Test helpers. */
export function resetStreamTickets(): void {
  tickets.clear();
}

export function streamTicketCount(): number {
  return tickets.size;
}
