import { config } from '../../config/env';
import { encryptSecret, decryptSecret } from '../../lib/secretbox';
import { createLogger } from '../../lib/logger';

const log = createLogger('google');

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

export function googleConfigured(): boolean {
  return Boolean(config.googleClientId && config.googleClientSecret);
}

export function buildAuthUrl(redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: config.googleClientId!,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

export function callbackUrl(): string {
  if (config.googleRedirectUri) return config.googleRedirectUri;
  return `${config.appBaseUrl}/api/calendar/google/callback`;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
}

async function postToken(body: URLSearchParams): Promise<TokenResponse> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), config.outboundFetchTimeoutMs);
  try {
    const response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal
    });
    return (await response.json()) as TokenResponse;
  } finally {
    clearTimeout(t);
  }
}

export async function exchangeCodeForTokens(code: string): Promise<{
  encryptedAccessToken: string;
  encryptedRefreshToken?: string;
  expiresInSec: number;
}> {
  const token = await postToken(
    new URLSearchParams({
      code,
      client_id: config.googleClientId!,
      client_secret: config.googleClientSecret!,
      redirect_uri: callbackUrl(),
      grant_type: 'authorization_code'
    })
  );
  if (!token.access_token) {
    throw new Error(token.error ?? 'Token exchange failed');
  }
  return {
    encryptedAccessToken: encryptSecret(token.access_token),
    encryptedRefreshToken: token.refresh_token ? encryptSecret(token.refresh_token) : undefined,
    expiresInSec: token.expires_in ?? 3600
  };
}

export async function refreshAccessToken(encryptedRefreshToken: string): Promise<{
  encryptedAccessToken: string;
  expiresInSec: number;
}> {
  const refreshToken = decryptSecret(encryptedRefreshToken);
  const token = await postToken(
    new URLSearchParams({
      refresh_token: refreshToken,
      client_id: config.googleClientId!,
      client_secret: config.googleClientSecret!,
      grant_type: 'refresh_token'
    })
  );
  if (!token.access_token) {
    throw new Error(token.error ?? 'Refresh failed');
  }
  return { encryptedAccessToken: encryptSecret(token.access_token), expiresInSec: token.expires_in ?? 3600 };
}

export interface GoogleCalendarEvent {
  id: string;
  summary?: string;
  description?: string;
  status?: string;
  start?: { dateTime?: string; date?: string };
}

export async function listCalendarEvents(options: {
  encryptedAccessToken: string;
  syncToken?: string;
}): Promise<{ events: GoogleCalendarEvent[]; nextSyncToken?: string; gone?: boolean }> {
  let accessToken: string;
  try {
    accessToken = decryptSecret(options.encryptedAccessToken);
  } catch (err) {
    log.error('Failed to decrypt Google access token — rotation or corruption; forcing reconnect', err as Error);
    // Do not silently report an empty successful sync; surface as gone so the
    // caller disconnects and the user can reconnect. Previous implementation
    // returned {events:[], gone:true} without any log, making rotation
    // silently break sync forever.
    throw new Error('Google token decryption failed; reconnect required');
  }

  const params = new URLSearchParams({ maxResults: '250', singleEvents: 'true', orderBy: 'startTime' });
  if (options.syncToken) {
    params.set('syncToken', options.syncToken);
  } else {
    params.set('timeMin', new Date(Date.now() - 30 * 86400_000).toISOString());
  }

  // The timeout has to cover the body read, not just the headers. Clearing it the
  // moment `fetch` resolved left `response.json()` unbounded — and this response
  // can be megabytes across 250 events, so a peer that sends headers and then
  // stalls mid-body would hang the sync request (and the HTTP request awaiting it)
  // with no ceiling at all.
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), config.outboundFetchTimeoutMs);
  try {
    const response = await fetch(`${CALENDAR_API}/calendars/primary/events?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal
    });

    if (response.status === 410) {
      await discardBody(response);
      return { events: [], gone: true };
    }
    if (!response.ok) {
      await discardBody(response);
      throw new Error(`Google Calendar API error ${response.status}`);
    }
    const payload = (await response.json()) as {
      items?: GoogleCalendarEvent[];
      nextSyncToken?: string;
    };
    return { events: payload.items ?? [], nextSyncToken: payload.nextSyncToken };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Releases the connection behind a response we have decided not to read.
 *
 * Returning from an error branch without touching the body leaves the socket
 * pinned until the runtime gets around to draining it, which on a keep-alive
 * agent means the next request waits on it.
 */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    /* already consumed or never had a body */
  }
}
