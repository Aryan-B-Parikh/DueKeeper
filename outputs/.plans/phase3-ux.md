# Plan: Phase 3 — UX (Onboarding, Upcoming, Extraction Trust)

**Slug:** `phase3-ux` · **Date:** 2026-08-25 · **Depends:** `phase2-hardening` (observability/backup)

## Goals (P2 11-13 + P1-10 UX pass)

- **11 Onboarding:** Register → Welcome → timezone detection → notification prefs → create first deadline (obvious)
- **12 Upcoming experience:** Primary screen shows TODAY / THIS WEEK grouped by due date, not just status filters. User shouldn't need to understand internal `upcoming/due_soon/overdue` model.
- **13 Extraction trust:** Screenshot/text → Detected: Title / Date / Time / Timezone / Confidence (94%) → [Edit][Confirm]; never silently create low-confidence deadline; leverage existing `needsClarification` + `user_confirmed` flow.
- **P1-10:** Auth (register/login/wrong password/expiry/refresh/logout everywhere/password change), dashboard empty/1/100/overdue/due-soon/done + pagination/filters/mobile, deadline creation for Asia/Kolkata, America/New_York, UTC, DST, invalid/past/same-day/large reminder
- **P1 Mobile:** Treat as beta but verify login persistence, refresh, offline, push tap → deadline, background

## Scope

- `web/src/app/(dashboard)/dashboard/page.tsx` (overview → Upcoming grouped view)
- `web/src/app/(auth)/login/page.tsx` + `register/page.tsx` + `web/src/hooks/useRequireAuth.tsx` (auth states)
- `web/src/components/EventForm.tsx` (deadline creation, timezone, DST, validation)
- `web/src/components/ExtractionPreview.tsx` (confidence, timezone, edit/confirm)
- `web/src/components/EventCard.tsx` (mobile, empty, overdue visual)
- New: `web/src/components/Onboarding.tsx` + `web/src/app/(dashboard)/dashboard/onboarding/page.tsx` or modal
- New: `web/src/components/UpcomingSection.tsx` (TODAY / THIS WEEK / LATER)
- `web/src/lib/utils.ts` (date grouping helpers)
- `web/src/app/globals.css` (mobile responsive, empty/loading/error)

## Scale Decision

**Direct (lead-owned) for docs + small components; 1 worker for Upcoming + Onboarding slices.** No broad researcher fanout — UX is bounded.

## Task Ledger

| ID | Task | Owner | Status |
|---|---|---|---|
| U1 | Upcoming: TODAY / THIS WEEK / LATER grouping, keep filter as secondary, add empty state | worker | pending |
| U2 | Onboarding: welcome → timezone detect (Intl) → prefs → first deadline CTA | worker | pending |
| U3 | Extraction trust: show confidence %, timezone, needsClarification badge, [Edit][Confirm] never auto-save <0.7 | worker | pending |
| U4 | Auth polish: wrong password, expiry, refresh, logout everywhere visible | lead | pending |
| U5 | Mobile + a11y pass (viewport, touch targets, error/loading) | lead | pending |

## Verification

- Manual: Register → Welcome → timezone → prefs → first deadline → TODAY shows it
- Manual: Upload screenshot → see Detected Title/Date/Time/Timezone/Confidence → Edit → Confirm → Upcoming
- Manual: `Asia/Kolkata`, `America/New_York`, `UTC`, DST transition, invalid/past dates, pagination 100
- `npm run typecheck` 0, `npm run build` 0, `npm test` 129/129 unchanged

## Decision Log

| Date | Decision | Reason |
|---|---|---|
| 2026-08-25 | Keep existing `EventCard`/`StatusBadge`/`ReminderConfig`, add `UpcomingSection` + `Onboarding` as new components | Preserve current `routes→services→db` + `StatusBadge` model, don’t rewrite backend for UX |
| 2026-08-25 | Group by calendar date (local timezone), not by `status` enum | User mental model is “when is it due” not “what status the DB computed” |
