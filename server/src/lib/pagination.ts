import { ValidationError } from './errors';

/**
 * Cursor-free pagination shared by every list endpoint.
 *
 * Offset pagination is the right fit here: the result sets are per-user and
 * small, and the sort keys (`due_at`, `created_at`) are not unique, which makes
 * a keyset cursor fiddlier than it is worth at this scale.
 *
 * The parsing deliberately *rejects* malformed values rather than ignoring them.
 * The previous code did `Number.isFinite(x) ? … : undefined`, so `?limit=abc`
 * silently fell back to the default and a client with a broken parameter
 * received a plausible-looking wrong page with no indication anything was off.
 */
export interface PageMeta {
  limit: number;
  offset: number;
  total: number;
  hasMore: boolean;
}

export interface PageRequest {
  limit: number;
  offset: number;
}

export interface Paged<T> {
  items: T[];
  total: number;
}

function parseIntParam(raw: unknown, name: string): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (Array.isArray(raw)) throw new ValidationError(`${name} must be given once`);
  if (typeof raw !== 'string') throw new ValidationError(`${name} must be an integer`);
  if (!/^\d+$/.test(raw.trim())) {
    throw new ValidationError(`${name} must be a non-negative integer`);
  }
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value)) throw new ValidationError(`${name} is too large`);
  return value;
}

export function parsePageRequest(
  query: Record<string, unknown>,
  options: { defaultLimit: number; maxLimit: number }
): PageRequest {
  const limitRaw = parseIntParam(query.limit, 'limit');
  const offset = parseIntParam(query.offset, 'offset') ?? 0;
  // A limit above the cap is clamped rather than refused: asking for more than
  // the server will give is not a client error, but silently serving 10,000 rows
  // from a synchronous SQLite driver would block the event loop.
  const limit = Math.min(Math.max(limitRaw ?? options.defaultLimit, 1), options.maxLimit);
  return { limit, offset };
}

export function pageMeta(request: PageRequest, total: number): PageMeta {
  return {
    limit: request.limit,
    offset: request.offset,
    total,
    hasMore: request.offset + request.limit < total
  };
}
