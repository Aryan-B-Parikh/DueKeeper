type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const minLevel: Level =
  (process.env.LOG_LEVEL as Level) && LEVEL_ORDER[process.env.LOG_LEVEL as Level]
    ? (process.env.LOG_LEVEL as Level)
    : process.env.NODE_ENV === 'production'
      ? 'info'
      : 'debug';

/**
 * Keys whose values never belong in a log line.
 *
 * Matched loosely on purpose: over-redacting a field called `tokenCount` costs
 * nothing, while under-redacting one called `refresh_token` puts a live
 * credential in whatever aggregates stdout.
 */
const SENSITIVE_KEY_RE =
  /(token|secret|password|passwd|authorization|\bauth\b|cookie|session|apikey|api_key|privatekey|private_key|credential|signature|vapid|jwt)/i;

const MAX_DEPTH = 6;
const MAX_ENTRIES = 50;
const MAX_STRING = 2000;

function redactString(value: string): string {
  let out = value;
  // Inbox forwarding tokens grant write access to a user's deadlines.
  out = out.replace(/deadline\+[a-f0-9]{8,64}/gi, 'deadline+***');
  // Credential-shaped query parameters, wherever a URL appears. `code` and
  // `state` are only assumed to be OAuth values in this position — outside a
  // query string, `code=` is far more likely to be an error code worth keeping.
  out = out.replace(/([?&](?:token|key|access_token|api_key|code|state|ticket)=)[^&\s"']+/gi, '$1***');
  // The unambiguous names as bare key=value pairs, which is how they arrive in
  // messages from upstream services. Matched on the same substring principle as
  // SENSITIVE_KEY_RE, and the key itself is preserved so the line stays useful.
  out = out.replace(
    /[\w-]*(?:token|secret|passwd|password|apikey|api_key|credential|ticket)[\w-]*=[^&\s"']+/gi,
    (match) => `${match.slice(0, match.indexOf('='))}=***`
  );
  out = out.replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***');
  // Anything JWT-shaped, wherever it appears.
  out = out.replace(/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, '[JWT]');
  if (/forwarding_token/i.test(out)) out = '[REDACTED]';
  return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING)}…[truncated]` : out;
}

/**
 * Redacts and shapes a value for serialization.
 *
 * Depth, breadth and cycle limits are not tidiness — the previous version
 * recursed unguarded, so logging any object with a reference back to itself (a
 * request, a socket, a Node error with a circular `cause`) overflowed the stack.
 * A logger that throws while reporting a failure turns a handled error into a
 * crash.
 */
function redact(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'function') return '[Function]';
  if (typeof value === 'symbol') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return errorShape(value, depth, seen);
  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    if (depth >= MAX_DEPTH) return '[MaxDepth]';
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        const items = value.slice(0, MAX_ENTRIES).map((item) => redact(item, depth + 1, seen));
        if (value.length > MAX_ENTRIES) items.push(`…${value.length - MAX_ENTRIES} more`);
        return items;
      }
      if (value instanceof Map || value instanceof Set) return `[${value.constructor.name} size=${value.size}]`;
      if (Buffer.isBuffer(value)) return `[Buffer ${value.length}b]`;
      const out: Record<string, unknown> = {};
      let count = 0;
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (count >= MAX_ENTRIES) {
          out['…'] = 'truncated';
          break;
        }
        count += 1;
        out[key] = SENSITIVE_KEY_RE.test(key) ? '[REDACTED]' : redact(child, depth + 1, seen);
      }
      return out;
    } finally {
      seen.delete(value);
    }
  }
  return String(value);
}

function errorShape(err: Error, depth: number, seen: WeakSet<object>): Record<string, unknown> {
  const shape: Record<string, unknown> = {
    name: err.name,
    message: redactString(err.message),
    stack: err.stack ? redactString(err.stack) : undefined
  };
  const cause = (err as { cause?: unknown }).cause;
  if (cause !== undefined && depth < MAX_DEPTH) shape.cause = redact(cause, depth + 1, seen);
  return shape;
}

/** Serializes without ever throwing: a failed log line must not fail a request. */
function safeStringify(entry: Record<string, unknown>): string {
  try {
    return JSON.stringify(entry);
  } catch {
    try {
      return JSON.stringify({ ts: entry.ts, level: entry.level, scope: entry.scope, msg: entry.msg });
    } catch {
      return `{"level":"error","msg":"log serialization failed"}`;
    }
  }
}

function emit(level: Level, scope: string, message: string, meta?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    scope,
    msg: typeof message === 'string' ? redactString(message) : String(message)
  };
  if (meta !== undefined) {
    if (meta instanceof Error) entry.err = errorShape(meta, 0, new WeakSet());
    else entry.meta = redact(meta);
  }
  const line = safeStringify(entry);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
  child(childScope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, meta) => emit('debug', scope, m, meta),
    info: (m, meta) => emit('info', scope, m, meta),
    warn: (m, meta) => emit('warn', scope, m, meta),
    error: (m, meta) => emit('error', scope, m, meta),
    child: (childScope: string) => createLogger(`${scope}:${childScope}`)
  };
}

/** Exported for tests: the redaction and cycle rules are load-bearing. */
export const __loggerInternals = { redact, redactString, safeStringify };
