# Setup Guide

## Prerequisites

- **Node.js ≥ 24** (uses the stable built-in `node:sqlite`)
- npm 10+

That's it. No Postgres, no Docker, no external accounts needed for local development.

## Run locally

```bash
npm run setup          # installs server/ + web/
npm run dev:server     # API  → http://localhost:8080
npm run dev:web        # Web  → http://localhost:3000
```

Open http://localhost:3000 → register → add deadlines. The SQLite file is created at `server/data/duekeeper.db` and migrations run automatically.

### Verify

```bash
cd server
npm run typecheck      # strict TS, zero errors
npm run smoke          # 40-check end-to-end suite (needs the API running)
```

## Environment variables — server (`server/.env`, see `.env.example`)

| Variable | Required | Purpose |
|---|---|---|
| `PORT` | – | default `8080` |
| `NODE_ENV` | – | `production` enables startup safety checks |
| `APP_BASE_URL` | prod | public API origin; **must be HTTPS in prod** (used for Google OAuth redirect) |
| `WEB_APP_URL` | if using OAuth | where `/api/calendar/google/callback` redirects after consent |
| `DB_PATH` | – | SQLite file path, default `./data/duekeeper.db` |
| `JWT_SECRET` | yes | ≥32 random chars in prod; dev falls back to an ephemeral secret with a warning |
| `JWT_EXPIRES_IN` | – | e.g. `7d` |
| `ENCRYPTION_KEY` | yes (prod) | base64 of 32 bytes → generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `CORS_ALLOWED_ORIGINS` | yes | comma-separated origins, e.g. `https://app.yourdomain.com` |
| `GEMINI_API_KEY` | optional | enables AI extraction (text + screenshots). Without it, text extraction uses the built-in heuristic parser |
| `GEMINI_MODEL` | – | default `gemini-2.5-flash` |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | optional | real email delivery; without it emails log to console as `[DEV EMAIL]` |
| `EMAIL_FROM` | – | e.g. `"DueKeeper <no-reply@yourdomain.com>"` |
| `INBOX_DOMAIN` | – | domain for forwarding addresses, default `inbox.duekeeper.local` |
| `INBOX_WEBHOOK_TOKEN` | optional | long random string; enables `/api/inbox/webhook/:token` when set |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | optional | enables Google Calendar sync |
| `GOOGLE_REDIRECT_URI` | optional | override the OAuth redirect URI if your Google client already registers a specific path (default `<APP_BASE_URL>/api/calendar/google/callback`; the callback is also always served at `/api/calendar/sync/callback`) |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | optional | Web Push server keys. In dev, a keypair is auto-generated and cached at `server/data/vapid.json`; in production set both (generate with `node scripts/generate-vapid.mjs`) — without them browser push is disabled but everything else works |
| `OUTBOX_LEASE_SECONDS` / `OUTBOX_CLAIM_LIMIT` / `OUTBOX_MAX_ATTEMPTS` | – | engine tuning |

## Environment variables — web (`web/.env.local`)

| Variable | Default | Purpose |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | `http://localhost:8080` | API base URL |

## Feature configuration walkthroughs

All integrations are **optional** — the app is fully usable with none of them.

### Gemini AI extraction
1. Get a key from Google AI Studio.
2. Set `GEMINI_API_KEY`. Restart. Text extraction now uses Gemini first (falls back to heuristics on errors); the Screenshot tab becomes available.

### Real email delivery
1. Use any SMTP provider (Gmail app password, Resend SMTP, Mailgun…).
2. Set `SMTP_HOST`, `SMTP_PORT` (587 or 465), `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`.
3. Email reminders and inbox receipts now send for real.

### Inbox forwarding (SendGrid Inbound Parse)
1. Own a domain. Set `INBOX_DOMAIN=yourdomain.com` and any long random `INBOX_WEBHOOK_TOKEN`.
2. In SendGrid: Inbound Parse → MX record on the subdomain → POST URL:
   `https://<your-api>/api/inbox/webhook/<INBOX_WEBHOOK_TOKEN>` (check "spam" off, raw off).
3. Each user's address (`deadline+<token>@yourdomain.com`) appears under Settings → Forwarding address.
4. Local testing: use ngrok and point SendGrid at your tunnel URL.

### Google Calendar sync
1. Google Cloud Console → OAuth client (Web application). Authorized redirect URI:
   `https://<your-api>/api/calendar/google/callback` (locally: `http://localhost:8080/api/calendar/google/callback`).
2. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `WEB_APP_URL=http://localhost:3000`.
3. Dashboard → Settings → Connect Google → Sync now. Only deadline-keyword events are imported; sync is incremental.

## Production deployment

- **API**: build the Docker image (`server/Dockerfile` — multi-stage, non-root, healthchecked) to any host with a persistent volume mounted at `DB_PATH`. Or use the included Render blueprint (`render.yaml`). Remember: SQLite wants single-instance deploys or shared storage.
- **Web**: deploy `web/` to Vercel (`vercel.json` included) with `NEXT_PUBLIC_API_URL=https://api.yourdomain.com`.
- Set all production env vars; the server refuses to start with unsafe config (weak JWT secret, missing encryption key, non-HTTPS base URL, localhost CORS).

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Screenshot tab disabled" banner | Expected without `GEMINI_API_KEY`; paste text instead |
| Emails show as `[DEV EMAIL]` logs | Set SMTP_* vars for real delivery |
| Inbox webhook returns 404 | `INBOX_WEBHOOK_TOKEN` not set |
| Google button hidden | `GOOGLE_CLIENT_ID/SECRET` not set |
| Reminders don't fire | Check event has reminders within the next 7 days; engine cycles every 60s/30s; watch server logs for `planner`/`outbox` entries |
| Tokens reset on server restart (dev) | You're running without `JWT_SECRET` — set one |

## Mobile app (Expo)

```bash
cd mobile
npm install
npx expo start          # Metro dev server; scan QR for Expo Go (UI only)
```

- API base URL: set `EXPO_PUBLIC_API_URL` (per-profile in `eas.json`). Defaults to `http://10.0.2.2:8080`, which is how the Android emulator reaches your machine.
- **Installable Android APK**: `npm i -g eas-cli`, `eas login`, then `eas build --profile apk --platform android`. Install the artifact directly on any phone.
- **Android push**: create a Firebase project, add an Android app with package `com.duekeeper.mobile`, upload the FCM v1 service-account key in your Expo project settings, rebuild. Without it, everything works except background push delivery.
- **iOS**: requires an Apple Developer account ($99/yr) + `eas build --platform ios`; APNs key uploaded to Expo settings. Push on iOS requires the installed (native) build — not Expo Go.

Auth, refresh rotation and all API contracts are identical to the web client; tokens live in SecureStore (Keychain/Keystore).

## Deploy to Render (API + Web)

Prerequisites: GitHub/GitLab repo pushed (Render pulls from it), and the generated secrets file `.env.render.secrets` at the repo root (gitignored).

1. Render Dashboard → **New → Blueprint**, select this repo — `render.yaml` creates both services (`duekeeper-api` Docker + disk, `duekeeper-web` Node).
2. When prompted for the `sync: false` variables, paste values from `.env.render.secrets`, replacing every `REPLACE-WITH-YOUR-*-URL.onrender.com` with the real URLs Render assigns (visible after first deploy; they match the service names if available: `https://duekeeper-api.onrender.com`, `https://duekeeper-web.onrender.com`).
3. First deploy order matters:
   - Create **api** first → note its URL → set `APP_BASE_URL`, `WEB_APP_URL`, `CORS_ALLOWED_ORIGINS`, `GOOGLE_REDIRECT_URI` to the real URLs → redeploy api.
   - Then create **web** with `NEXT_PUBLIC_API_URL=https://<your-api-url>` (this is baked at build time — change it later via Environment + Manual Deploy).
4. Verify: open `https://<api>/api/health` → `{"ok":true}`; register on the website.

Free-tier notes: services sleep after ~15 min idle (first request wakes them); the 1 GB disk keeps SQLite persistent across deploys.

## Android push via Firebase (Expo)

1. https://console.firebase.google.com → Add project (any name).
2. Project settings → Your apps → Android → package name `com.duekeeper.mobile` → download `google-services.json`.
3. Drop the file at `mobile/google-services.json` (gitignored).
4. Firebase → Project settings → Service accounts → Generate new private key (JSON).
5. On expo.dev → your project → Settings → Service credentials / Push credentials → upload that JSON as **FCM v1 key**.
6. Build & install:

```bash
cd mobile
eas build --profile apk --platform android     # uses deployed API URL from eas.json
```

7. In-app: Settings → Enable push → Send test push (web Settings page also triggers mobile delivery now).
