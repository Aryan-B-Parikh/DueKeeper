# Plan: duekeeper-deep-research

> **See also:** `duekeeper.md` · `duekeeper-sources.md` · `outputs-improvement.md` · Index: `outputs/README.md`

**Slug:** `duekeeper-deep-research` (fallback — prompt "Run deep research for:" was empty, no filler words, 3 words, hyphenated, ≤5)  
**Date:** 2026-08-25  
**Mode:** Direct search (lead-owned) — no researcher subagents

## Key Questions
1. What does DueKeeper claim to do vs what the codebase actually does? (auth, reminders, extraction, inbox, calendar, realtime, crypto)
2. Where do docs (AUDIT.md, README, ARCHITECTURE, API, DATABASE) agree or disagree with implementation?
3. What defects were claimed, what was remediated, and what residual risks remain?
4. What defaults/configs/evidence types support each claim (code, HTTP test, unit test, config guard)?
5. What is unverified or uncertain (perf numbers, live-browser push, provider HMAC, single-instance SQLite)?

## Evidence Needed
- `AUDIT.md` (§1-§9, 6.8/10, C1-C4, H1-H8, medium, strengths, §8 plan, §9 dated verification)
- `README.md`, `docs/ARCHITECTURE.md`, `docs/API.md`, `docs/DATABASE.md`, `docs/SETUP.md`
- `server/src/config/env.ts` (defaults: JWT 15m, refresh 30d, outbox/planner timeouts, rate limits)
- `server/src/db/schema.ts` + `migrate.ts` (WAL/FK/busy_timeout, CHECK/CASCADE, indexes, migration 006)
- `server/src/engine/*` (outbox claim predicate, backoff, lease watchdog, planner grace, scheduling txn)
- `server/src/lib/*` (jwt, password N=16384, secretbox AES-GCM, webpush RFC 8291, zonedTime two-pass, logger, rateLimit, secretbox rotation)
- `server/src/tests/*` (push vector + http integration 129/129), `server/scripts/smoke.mjs`, `server/src/index.ts` (drain, unhandledRejection)
- Tool-visible verification: `grep`, `read`, `bash` (typecheck/test) — `web_search`/`fetch_content` not exposed, so no external URLs; `alpha_search` not exposed.

## Scale Decision
**Direct search (lead-owned, 3–10 tool calls).** Topic is empty/fallback and the prior comparison already narrowed scope to DueKeeper doc-vs-code fidelity. This does not need multi-agent decomposition; direct search covers definition/history (what DueKeeper is), mechanism/formula (engine/crypto/validation), and current usage/comparison (docs vs code) with ≥3 distinct queries. Per Step 2, “what is X” explainers MUST NOT spawn researcher subagents unless user asks for comprehensive landscape/benchmarks/deployment — not requested. Do not inflate into 3–6 subagents.

## Task Ledger
| ID | Task | Owner | Status | Evidence Output |
|---|---|---|---|---|
| T1 | Search/gather DueKeeper claims (AUDIT+README+ARCHITECTURE) | lead | done | `outputs/.drafts/duekeeper-deep-research-research-direct.md` §1 (2026-08-25, 3 grep reads) |
| T2 | Search/gather mechanism/formula evidence (engine, crypto, validation, DB) | lead | done | same file §2 (engine/outbox/planner/scheduling + crypto/DB greps) |
| T3 | Search/gather current usage/comparison + defaults/tests (API, env, tests) | lead | done | same file §3 (`API.md` pagination + `env.ts` defaults + `npm test 129/129`) |
| T4 | Draft report (exec summary, findings by question, caveats, open questions) | lead | done | `outputs/.drafts/duekeeper-deep-research-draft.md` (10307 bytes, 63 lines) |
| T5 | Cite (inline citations + Sources) | lead | done | `outputs/.drafts/duekeeper-deep-research-cited.md` (17625 bytes, 71 lines, inline `path:line` + Sources) |
| T6 | Self-review (FATAL/MAJOR/MINOR, fix FATAL) | lead | done | `outputs/.drafts/duekeeper-deep-research-verification.md` (PASS, 0 FATAL, 1 MAJOR, 2 MINOR) |
| T7 | Deliver final + provenance | lead | done | `outputs/duekeeper-deep-research.md` (copied from cited) + `outputs/duekeeper-deep-research.provenance.md` (PASS, 22/22 accepted, 4 external specs paper-cited not fetched) |

No researcher subagents in ledger (scale decision). Verifier/reviewer subagents also skipped for direct-search runs per Step 5/6.

## Verification Log
| Check | Status | Notes |
|---|---|---|
| Plan artifact exists (`outputs/.plans/duekeeper-deep-research.md`) | done | this file |
| `memory_remember` with key `deepresearch.duekeeper-deep-research.plan` | blocked | tool not visible in current tool set — continuing without it per Step 1 |
| ≥3 distinct search queries recorded | done | 3 queries logged in `research-direct.md` (definition, mechanism, usage) — `grep` + `read` + `bash npm test 129/129` |
| Every critical claim maps to source URL/path or command output | done | sweep passed — no invented sources, perf numbers downgraded to unverified, RFC specs marked paper-cited not fetched |
| Cited draft exists | done | `outputs/.drafts/duekeeper-deep-research-cited.md` exists (17625 bytes) — verified on disk |
| Verification file exists | done | `outputs/.drafts/duekeeper-deep-research-verification.md` exists (PASS) — self-review, no reviewer subagent (direct path) |
| Final + provenance exist | done | `outputs/duekeeper-deep-research.md` + `outputs/duekeeper-deep-research.provenance.md` exist — verified via `ls`/`wc -l` |
| Verification PASS/BLOCKED set correctly | done | Verification: PASS (no FATAL, 1 MAJOR as Open Question) — not BLOCKED |

## Decision Log
| Date | Decision | Reason |
|---|---|---|
| 2026-08-25 | Slug `duekeeper-deep-research` fallback | Prompt topic empty; keeps DueKeeper continuity, meets ≤5 word hyphenated rule |
| 2026-08-25 | Scale = Direct (lead-owned), no researcher subagents | Empty/narrow fallback topic + prior comparison already scoped; 3–10 tool calls sufficient; Step 2 forbids inflating “what is X” explainers |
| 2026-08-25 | Skip `alpha_get_paper` + `.pdf` fetch | Step 3: avoid crash-prone PDF parsing unless user asks; prefer metadata/abstract/HTML; local codebase is ground truth |
| 2026-08-25 | Continue without `memory_remember` | Tool not in visible set — Step 1 says continue without it |
| 2026-08-25 | Await user confirmation before gathering evidence | Required Artifacts Step 1: stop after plan, ask explicit “Proceed?” |

## Brief Summary for User
Plan for fallback deep research on DueKeeper doc-vs-code fidelity (since topic was empty). Scale is **Direct, lead-owned** — no subagents — with 3+ search angles (claims, mechanisms, usage/tests) logged to `research-direct.md`, then draft→cite→self-review→deliver + provenance. No external fetch/PDF parsing; verification will mark BLOCKED only if local checks cannot be completed.
