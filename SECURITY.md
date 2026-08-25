# Security Policy — DueKeeper

**Supported versions:** `main` (active) — historical audit `SECURITY-AUDIT-2026-08-24.md` (remediated in `c4785e8`/`429e2a0`).

## Reporting a Vulnerability

- **Contact:** `security@duekeeper.local` (or open a private security advisory on GitHub if enabled).
- **Please include:** affected version/commit, repro steps, impact, and whether exploit requires auth.
- **Response:** acknowledge within 48h, triage within 5 days, fix + disclosure coordinated with reporter.
- **Do not** open a public issue for an unpatched vulnerability.

## Disclosure Process

1. Reporter → security contact (private).
2. Maintainer reproduces, fixes on a private branch, adds test that would have caught it.
3. Release + advisory published, reporter credited (if desired), CVE requested when applicable.

## Hardening Already In Place

- HS256 JWT (no `alg` parsing, `timingSafeEqual`, `iss`/`aud`/`exp` enforced) + `token_version` revocation + rotating refresh with theft detection (`lib/tokens.ts`, `middleware/auth.ts`)
- Rate limits (`X-Forwarded-For` not trusted, `req.ip` via `trust proxy`, `maxKeys` bound, per-IP + per-email, refresh/logout/password caps)
- OAuth `state` validated/consumed/bound before token exchange, public callback
- Inbox `X-Inbox-Token` header-only + `X-Inbox-Signature` HMAC (`sha256=`), `To`-only resolution, `To` display-name parsing
- Strict validation (offset-required `dueAt`, IANA zone, two-pass DST, snooze bounds, ICS escaping, pagination in SQL)
- Outbox `FOR UPDATE SKIP LOCKED` when `DATABASE_URL` set (PG) else `BEGIN IMMEDIATE` (SQLite), lease + `reclaims`, `inTransaction` SAVEPOINT nesting
- Production guards (`JWT_SECRET≥32`, `ENCRYPTION_KEY` 32B + `!=JWT_SECRET`, `APP_BASE_URL https`, `CORS`, `SMTP_HOST` required; `ALLOW_LOCALHOST_E2E=1` escape hatch)

## Operational Security

- Secrets via platform secret manager (Render/Vercel), never committed `.env`
- `npm audit` / `Dependabot` / `Trivy` in CI, `Semgrep` rules for injection, `OWASP ZAP` for manual pass before prod
- Structured JSON logs with `X-Request-Id`, redaction of `token`/`deadline+…`/`Bearer`/`[JWT]` in `lib/logger.ts`
- Prometheus `/metrics` + `/api/metrics` queue depth (`outboxDeadLettered`, `oldestClaimableAgeSeconds`, `unhandledErrors`)
