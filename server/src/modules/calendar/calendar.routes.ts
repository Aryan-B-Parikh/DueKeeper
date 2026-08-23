import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { handler, parseWith } from '../../middleware/validate';
import { prepare, inTransaction } from '../../db/database';
import { uuid } from '../../lib/ids';
import { nowIso } from '../../lib/time';
import { parseIcsCalendar, generateIcsCalendar } from '../../lib/ics';
import { createEvent } from '../events/events.service';
import { googleConfigured, buildAuthUrl, callbackUrl, exchangeCodeForTokens, refreshAccessToken, listCalendarEvents } from './google';
import { config } from '../../config/env';
import { NotFoundError, ValidationError } from '../../lib/errors';

export const calendarRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 }
});

calendarRouter.use(requireAuth());

interface ConnectionRow {
  user_id: string;
  encrypted_access_token: string | null;
  encrypted_refresh_token: string | null;
  token_expires_at: string | null;
  sync_token: string | null;
  last_synced_at: string | null;
}

calendarRouter.get(
  '/status',
  handler(async (req, res) => {
    const connection = prepare('SELECT last_synced_at FROM calendar_connections WHERE user_id = ?').get(
      req.user!.id
    ) as { last_synced_at: string | null } | undefined;
    res.json({
      googleConfigured: googleConfigured(),
      connected: Boolean(connection),
      lastSyncedAt: connection?.last_synced_at ?? null,
      importExportEnabled: true
    });
  })
);

calendarRouter.get(
  '/export.ics',
  handler(async (req, res) => {
    const rows = prepare(
      `SELECT id, title, due_at, description FROM events
       WHERE user_id = ? AND status NOT IN ('cancelled') ORDER BY due_at ASC`
    ).all(req.user!.id) as unknown as Array<{ id: string; title: string; due_at: string; description: string | null }>;
    const ics = generateIcsCalendar(
      rows.map((row) => ({ id: row.id, title: row.title, dueAt: row.due_at, description: row.description }))
    );
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="duekeeper.ics"');
    res.send(ics);
  })
);

calendarRouter.post(
  '/import',
  upload.single('file'),
  handler(async (req, res) => {
    const raw =
      req.file?.buffer.toString('utf8') ?? (typeof req.body?.ics === 'string' ? req.body.ics : '');
    if (!raw.trim()) throw new ValidationError('Provide an .ics file upload or raw ics text');

    let parsed;
    try {
      parsed = parseIcsCalendar(raw);
    } catch {
      throw new ValidationError('Could not parse the iCalendar file');
    }
    if (parsed.length === 0) {
      res.json({ imported: 0, skipped: 0 });
      return;
    }

    let imported = 0;
    let skipped = 0;
    for (const item of parsed.slice(0, 100)) {
      if (!item.startUtcIso || !item.title) {
        skipped += 1;
        continue;
      }
      const duplicate = prepare(
        `SELECT id FROM external_events WHERE user_id = ? AND provider = 'ics' AND external_id = ?`
      ).get(req.user!.id, item.uid);
      if (duplicate) {
        skipped += 1;
        continue;
      }
      const event = createEvent(req.user!.id, {
        title: item.title,
        description: item.description ?? null,
        eventType: 'other',
        dueAt: item.startUtcIso,
        timezone: 'UTC',
        reminders: [{ offsetSeconds: 86400, channel: 'in_app' }],
        source: 'ics_import'
      });
      prepare(
        `INSERT INTO external_events (id, user_id, provider, external_id, event_id, imported_at)
         VALUES (?, ?, 'ics', ?, ?, ?)`
      ).run(uuid(), req.user!.id, item.uid, event.id, nowIso());
      imported += 1;
    }
    res.json({ imported, skipped });
  })
);

function requireGoogleConfigured(): void {
  if (!googleConfigured()) {
    throw new ValidationError('Google Calendar sync requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET');
  }
}

calendarRouter.get(
  '/google/start',
  handler(async (req, res) => {
    requireGoogleConfigured();
    const state = uuid();
    prepare('INSERT INTO oauth_states (state, user_id, expires_at, used, created_at) VALUES (?, ?, ?, 0, ?)').run(
      state,
      req.user!.id,
      new Date(Date.now() + 10 * 60_000).toISOString(),
      nowIso()
    );
    res.redirect(302, buildAuthUrl(callbackUrl(), state));
  })
);

async function googleCallback(req: Request, res: Response): Promise<void> {
  const stateValue = typeof req.query.state === 'string' ? req.query.state : '';
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const redirectFail = `${config.webAppUrl}/dashboard/settings?google=error`;

  if (!googleConfigured() || !code || !stateValue) {
    res.redirect(302, redirectFail);
    return;
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    inTransaction(() => {
      const stateRow = prepare('SELECT user_id, used, expires_at FROM oauth_states WHERE state = ?').get(
        stateValue
      ) as { user_id: string; used: 0 | 1; expires_at: string } | undefined;
      if (!stateRow || stateRow.used === 1 || new Date(stateRow.expires_at).getTime() < Date.now()) {
        throw new Error('Invalid OAuth state');
      }
      prepare('UPDATE oauth_states SET used = 1 WHERE state = ?').run(stateValue);

      prepare(
        `INSERT INTO calendar_connections
           (user_id, provider, encrypted_access_token, encrypted_refresh_token, token_expires_at, connected_at)
         VALUES (?, 'google', ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           encrypted_access_token = excluded.encrypted_access_token,
           encrypted_refresh_token = COALESCE(excluded.encrypted_refresh_token, calendar_connections.encrypted_refresh_token),
           token_expires_at = excluded.token_expires_at,
           sync_token = NULL,
           connected_at = excluded.connected_at`
      ).run(
        stateRow.user_id,
        tokens.encryptedAccessToken,
        tokens.encryptedRefreshToken ?? null,
        new Date(Date.now() + tokens.expiresInSec * 1000 - 60_000).toISOString(),
        nowIso()
      );
    });
    res.redirect(302, `${config.webAppUrl}/dashboard/settings?google=connected`);
  } catch {
    res.redirect(302, redirectFail);
  }
}

calendarRouter.get('/google/callback', handler(googleCallback));
calendarRouter.get('/sync/callback', handler(googleCallback));

async function getValidAccessToken(userId: string): Promise<string> {
  const connection = prepare('SELECT * FROM calendar_connections WHERE user_id = ?').get(userId) as
    | ConnectionRow
    | undefined;
  if (!connection?.encrypted_access_token) throw new NotFoundError('Google connection');

  const expiresAt = connection.token_expires_at ? new Date(connection.token_expires_at).getTime() : 0;
  if (expiresAt > Date.now() + 60_000) {
    return connection.encrypted_access_token;
  }
  if (!connection.encrypted_refresh_token) {
    throw new ValidationError('Google token expired and no refresh token stored; reconnect required');
  }
  const refreshed = await refreshAccessToken(connection.encrypted_refresh_token);
  prepare(
    `UPDATE calendar_connections SET encrypted_access_token = ?, token_expires_at = ? WHERE user_id = ?`
  ).run(
    refreshed.encryptedAccessToken,
    new Date(Date.now() + refreshed.expiresInSec * 1000 - 60_000).toISOString(),
    userId
  );
  return refreshed.encryptedAccessToken;
}

const DEADLINE_KEYWORDS =
  /(exam|deadline|due|submit|submission|assignment|hackathon|interview|test|quiz|midterm|final|milestone|review)/i;

calendarRouter.post(
  '/google/sync',
  handler(async (req, res) => {
    requireGoogleConfigured();
    const accessToken = await getValidAccessToken(req.user!.id);
    const connection = prepare('SELECT sync_token FROM calendar_connections WHERE user_id = ?').get(
      req.user!.id
    ) as { sync_token: string | null } | undefined;
    if (!connection) throw new NotFoundError('Google connection');

    const result = await listCalendarEvents({ encryptedAccessToken: accessToken, syncToken: connection.sync_token ?? undefined });
    if (result.gone) {
      prepare(`UPDATE calendar_connections SET sync_token = NULL WHERE user_id = ?`).run(req.user!.id);
      const fresh = await listCalendarEvents({ encryptedAccessToken: accessToken });
      result.events = fresh.events;
      result.nextSyncToken = fresh.nextSyncToken;
    }

    let imported = 0;
    let skipped = 0;
    for (const gEvent of result.events) {
      if (!gEvent.id || !gEvent.summary || gEvent.status === 'cancelled') continue;
      const startIso = gEvent.start?.dateTime ?? (gEvent.start?.date ? `${gEvent.start.date}T00:00:00.000Z` : null);
      if (!startIso) continue;
      if (!DEADLINE_KEYWORDS.test(gEvent.summary)) {
        skipped += 1;
        continue;
      }

      const existingMapping = prepare(
        `SELECT event_id FROM external_events WHERE user_id = ? AND provider = 'google' AND external_id = ?`
      ).get(req.user!.id, gEvent.id) as { event_id: string } | undefined;

      if (existingMapping) {
        prepare(`UPDATE events SET title = ?, due_at = ?, description = ?, updated_at = ? WHERE id = ?`).run(
          gEvent.summary.slice(0, 200),
          startIso,
          gEvent.description?.slice(0, 2000) ?? null,
          nowIso(),
          existingMapping.event_id
        );
        continue;
      }

      const event = createEvent(req.user!.id, {
        title: gEvent.summary.slice(0, 200),
        description: gEvent.description?.slice(0, 2000) ?? null,
        eventType: 'other',
        dueAt: startIso,
        timezone: 'UTC',
        reminders: [{ offsetSeconds: 86400, channel: 'in_app' }],
        source: 'calendar'
      });
      prepare(
        `INSERT INTO external_events (id, user_id, provider, external_id, event_id, imported_at)
         VALUES (?, ?, 'google', ?, ?, ?)`
      ).run(uuid(), req.user!.id, gEvent.id, event.id, nowIso());
      imported += 1;
    }

    if (result.nextSyncToken) {
      prepare(`UPDATE calendar_connections SET sync_token = ?, last_synced_at = ? WHERE user_id = ?`).run(
        result.nextSyncToken,
        nowIso(),
        req.user!.id
      );
    } else {
      prepare(`UPDATE calendar_connections SET last_synced_at = ? WHERE user_id = ?`).run(nowIso(), req.user!.id);
    }

    res.json({ imported, updated: result.events.length - imported - skipped, scanned: result.events.length });
  })
);

calendarRouter.delete(
  '/google',
  handler(async (req, res) => {
    prepare(`DELETE FROM external_events WHERE user_id = ? AND provider = 'google'`).run(req.user!.id);
    const deleted = prepare(`DELETE FROM calendar_connections WHERE user_id = ? AND provider = 'google'`).run(
      req.user!.id
    );
    res.json({ ok: true, wasConnected: deleted.changes > 0 });
  })
);
