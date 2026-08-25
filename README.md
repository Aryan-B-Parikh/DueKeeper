# DueKeeper

**Never miss what's due.** A full-stack deadline & reminder platform: track exams, submissions and hackathons, extract deadlines from messy text or screenshots, forward emails to your own inbox address, import/export calendars, and get reminders delivered through a crash-safe notification engine.

> Built as a from-scratch, self-contained take on the same problem domain as "DeadlineKeeper" — but with zero external infrastructure required to run.

## Highlights

| Capability | How it works |
|---|---|
| **Own auth, no third party** | Email + password with scrypt hashing and hand-rolled HS256 JWTs (node:crypto only) |
| **Deadline CRUD** | Canonical UTC `dueAt` + IANA timezone; live status computation (`upcoming → due_soon → overdue`, plus `done` / `cancelled`), snooze `30m/2h/1d` |
| **AI extraction** | Google Gemini for text & screenshots when a key is configured — **plus a built-in heuristic parser** ("due Aug 30 11:59pm", "tomorrow 5pm", ISO dates, DD/MM, relative dates) that works with no API key at all |
| **Email inbox forwarding** | Every user gets `deadline+<token>@<domain>`; a webhook endpoint (SendGrid Inbound Parse-compatible) auto-captures deadlines with ≥70% confidence |
| **Calendar interop** | Import `.ics` (with TZID support + UID dedup), export all deadlines as `.ics`, optional Google Calendar OAuth sync with incremental `syncToken` |
| **Reliable reminders** | PostgreSQL-style **transactional outbox** on SQLite: planner → deliveries → outbox queue with job leases, exponential backoff, stale-lease watchdog, idempotent in-app delivery. At-least-once semantics |
| **Proactive alerts** | Events automatically raise a one-time "due soon" notification when they enter the 72-hour window (respects user prefs) |
| **Realtime UI** | Server-Sent Events push new notifications and unread counts to the open tab instantly — no polling |
| **Web Push, zero deps** | Hand-rolled VAPID (ES256) + RFC 8291 `aes128gcm` payload encryption on raw `node:crypto` — reminders reach the browser even with DueKeeper closed. Installable as a PWA |
| **Two channels** | In-app notifications (unread counts) + email via SMTP (console logging fallback in dev) |
| **Account ownership** | Change password, export everything you stored (JSON), delete your account with cascading wipe |
| **Hardened auth** | 15-min access tokens + rotating refresh tokens with theft detection, brute-force throttling on login AND register, session revocation via token versioning (sign out everywhere), strict CSP, production startup safety checks |
| **Measured performance** | ~6.8k req/s health, ~2.6k req/s authenticated reads at p99 < 30ms (concurrency 50) — run `node scripts/bench.mjs` yourself |

## Stack

- **Server**: Node.js 24 · Express 4 · TypeScript (strict) · `node:sqlite` (embedded, WAL) · zod validation · nodemailer · Flyway-style SQL migrations
- **Web**: Next.js 14 (App Router) · React 18 · TypeScript · Tailwind CSS 3 (neumorphic design system, dark/light/system themes) · lucide-react
- **Zero native dependencies. Zero external services required to boot.**

## Quickstart

```bash
# prerequisites: Node.js >= 24
npm run setup     # installs server/, web/ and the dev runner
npm run dev       # runs API (:8080) + web (:3000) together
```

Open http://localhost:3000, create an account, add deadlines.
The database file lives at `server/data/duekeeper.db` (auto-created and migrated).

Prefer separate terminals? `npm run dev:server` and `npm run dev:web`.
Full production stack in Docker? `docker compose up --build` (set `JWT_SECRET` and `ENCRYPTION_KEY` in a root `.env` first).

### Verify everything

```bash
cd server
npm run typecheck   # strict TS
npm test            # 49 unit tests (node:test) — parser, jwt, scrypt, AES-GCM,
                    # VAPID ES256 + RFC 8291 encryption round-trips, ICS, tz math
npm run smoke       # 67-check end-to-end suite against a running API
```

Unit tests cover JWT signing/verification, scrypt hashing, AES-GCM secretbox, ICS parsing/generation round-trips, timezone math (IST/NY/UTC), heuristic date extraction edge cases, rate-limiter semantics, VAPID ES256 signature verification and RFC 8291 payload encryption/decryption round-trips including tamper rejection.
The smoke suite drives a live server through auth security, CRUD, lifecycle/snooze, extraction, ICS round-trip + dedup, the real reminder delivery cycle, SSE streaming, account management, and login throttling.

## Repository layout

```
duekeeper/
├── server/                 # Express + TypeScript API
│   ├── src/
│   │   ├── app.ts          # wiring: CORS, routes, error envelope
│   │   ├── config/env.ts   # .env loader + production safety checks
│   │   ├── db/             # node:sqlite singleton, migrations, schema
│   │   ├── lib/            # jwt, password(scrypt), secretbox(AES-GCM), ics, errors, rate-limit...
│   │   ├── middleware/     # requireAuth, request context/security headers, error handler
│   │   ├── modules/        # auth, users, events, extract(gemini+heuristic),
│   │   │                   # notifications, calendar(ics+google), inbox(webhook)
│   │   └── engine/         # planner + outbox worker + channels (the reminder engine)
│   ├── scripts/smoke.mjs   # end-to-end verification suite
│   └── Dockerfile          # multi-stage, non-root, healthchecked
├── web/                    # Next.js 14 App Router UI
│   └── src/
│       ├── app/            # (auth)/login|register + dashboard/* pages
│       ├── components/     # EventCard, ExtractionPreview, ReminderConfig, Toasts...
│       └── lib/            # typed API client, auth context, tz-aware date utils
├── docs/                   # ARCHITECTURE / API / DATABASE / SETUP
└── .github/workflows/ci.yml
```


## Mobile app (Expo React Native)

`mobile/` is a native Android & iOS client sharing the same REST API — SecureStore-backed tokens, the same rotating-refresh flow, native push via expo-notifications delivered through the Expo Push service.

```bash
npm run dev:mobile          # start the Metro dev server
# scan the QR with Expo Go for a quick UI test (push needs a dev build), or:
cd mobile && eas build --profile apk --platform android   # installable APK via EAS
```

Configure `EXPO_PUBLIC_API_URL` in `mobile/eas.json` per profile (defaults to `http://10.0.2.2:8080` for the Android emulator). Android push delivery requires linking a Firebase project (FCM v1) to your Expo project; iOS additionally requires an Apple Developer account.
## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — system design, outbox lifecycle, security model
- [docs/API.md](docs/API.md) — full REST reference with error envelope
- [docs/DATABASE.md](docs/DATABASE.md) — schema reference and data rules
- [docs/SETUP.md](docs/SETUP.md) — env vars, Gemini/SMTP/Google/SendGrid configuration, deployment

## Deployment

- **API**: any Docker host — see `server/Dockerfile` and root `render.yaml` (Render blueprint).
- **Web**: Vercel (`web/vercel.json`) or any Node host. Set `NEXT_PUBLIC_API_URL`.

## License

MIT
