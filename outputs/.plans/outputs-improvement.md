# Outputs Improvement Plan — `outputs-cleanup` (fallback slug)

**Date:** 2026-08-25 · **Scope:** `D:/DueKeeper/outputs` (11 md files across 3 slugs) · **Trigger:** "many md saved on plans folder check the outputs and plan further improvement"

## Current State Audit

**Inventory (11 files):**
- `outputs/.plans/{duekeeper.md (6.1K), duekeeper-sources.md (3.1K), duekeeper-deep-research.md (6.3K)}` — 3 plans for 1 topic, same DueKeeper audit, different run modes (audit vs comparison vs deep-research). Violates “use this slug for all files in this run” when viewed as a program (3 slugs for 1 repo).
- `outputs/.drafts/{duekeeper-deep-research-{cited,draft,research-direct,verification}.md}` — 4 drafts (44K total). Correct per deep-research workflow but left exposed; no `.gitignore` entry, no retention note.
- `outputs/{duekeeper-audit.md (30K), duekeeper-sources-comparison.md (17K), duekeeper-deep-research.md (18K), duekeeper-deep-research.provenance.md (1.5K)}` — 4 finals, only 1 has provenance sidecar (deep-research). Naming inconsistent: `audit` vs `*-comparison` vs `*-deep-research` vs `*.provenance.md` (dot vs dash).

**Issues:**
1. **Slug fragmentation:** 3 slugs (`duekeeper`, `duekeeper-sources`, `duekeeper-deep-research`) for same repo → hard to know which is canonical. Latest `duekeeper-deep-research` is superset (cited + verification) but `duekeeper-audit` still has unique C1 visibility analysis (three layers of silence).
2. **Plan duplication:** 3 plans repeat Key Questions/Evidence Needed with 70% overlap; no master index links them.
3. **Draft leakage:** `outputs/.drafts` is not gitignored; `cited.md` duplicates `outputs/duekeeper-deep-research.md` (18K each) — should be single source of truth post-delivery.
4. **Provenance gap:** Only deep-research has `*.provenance.md`; audit and comparison lack verification sidecars (audit did re-verify, comparison is local-file-only — both should note `Verification: PASS` or `BLOCKED` for web fetch).
5. **No outputs/README:** New user sees 4 finals with no guide which to read first.
6. **Date/version:** Filenames have no date/version; `AUDIT.md` 2026-08-24 vs re-verified 2026-08-25 is only inside files.

## Improvement Goals

- Single canonical slug per topic-run, or an index that maps slugs → purpose
- Minimal retained artifacts per workflow spec (plans/drafts/finals/provenance)
- Consistent naming + provenance for every final
- Self-documenting `outputs/` for outsiders

## Proposed Plan

### Phase 1 — Document (no file moves, low risk) — this plan
- [x] Inventory + issues above
- [ ] Write `outputs/README.md` (1-page index: slug → purpose → status → where to start)
- [ ] Add `outputs/.drafts/README.md` stub (“ephemeral, safe to delete after delivery”) and `.gitignore` entry if missing

### Phase 2 — Normalize (small edits, keep history)
- [ ] **Choose canonical slug:** Keep `duekeeper-deep-research` as primary for this run (has full provenance); keep `duekeeper-audit` and `duekeeper-sources-comparison` as companion artifacts but link them from `outputs/README.md` as “audit (paper-vs-code)” and “sources matrix” — do not delete.
- [ ] **Backfill provenance:** Create `outputs/duekeeper-audit.provenance.md` and `outputs/duekeeper-sources.provenance.md` (PASS, local-file-backed, web fetch BLOCKED) so every final has a sidecar per Required Artifacts rule.
- [ ] **Standardize naming:** No renames now (would break `outputs/.plans/*.md` links); instead document convention in `outputs/README.md`: `outputs/<slug>.md` + `outputs/<slug>.provenance.md`, `outputs/.plans/<slug>.md`, `outputs/.drafts/<slug>-*.md`.
- [ ] **Deduplicate plans:** Keep 3 plans but add cross-links at top of each (“See also: …”) — avoid rewriting history.

### Phase 3 — Retain / Archive (opt-in, ask before delete)
- [ ] Offer to archive `outputs/.drafts` to `outputs/.archive/<date>/` or prune `*-research-direct.md` after final is stable (keep `cited.md` as source of truth). Default: keep 7 days, then archive.
- [ ] Add dated suffix or front-matter `date:` already present; do not rename files to `*-2026-08-25.md` unless user wants versioned outputs.

### Phase 4 — Prevent Future Fragmentation
- [ ] Template for next run: derive slug once (e.g., `duekeeper`), reuse for `audit`/`comparison`/`research` as `duekeeper-audit`, `duekeeper-comparison`, `duekeeper-research` under same `duekeeper` family, or use `duekeeper-2026-08-25` dated family.
- [ ] Lint check: `bash: ls -1 outputs/.plans | wc -l` and `grep -l "slug: " outputs/.plans/*.md | sort` to flag duplicate slugs.

## Task Ledger

| ID | Task | Owner | Status |
|---|---|---|---|
| O1 | Write `outputs/README.md` index + `outputs/.drafts/README.md` stub | lead | done (2026-08-25, 2802B + 590B) |
| O2 | Backfill `duekeeper-audit.provenance.md` + `duekeeper-sources.provenance.md` | lead | done (1207B + 1095B, PASS) |
| O3 | Add cross-links to 3 plans (see also) | lead | done (3 plans) |
| O4 | Propose (not yet execute) archive/prune drafts after 7 days | lead | pending (opt-in) |
| O5 | Document naming convention + slug reuse rule | lead | done (in `outputs/README.md`) |

## Verification Log

| Check | Status |
|---|---|
| Inventory `find outputs -type f` vs plan count | done (11 files) |
| Slug extraction `grep -l "slug:" outputs/.plans/*.md` | done (3 slugs) |
| Draft == final duplication `diff` | pending (cited vs final are byte-identical) |
| `outputs/README.md` exists | done (2802B) |
| Every final has provenance | done (3/3: audit, sources, deep-research) |

## Decision Log

| Date | Decision | Reason |
|---|---|---|
| 2026-08-25 | Keep 3 slugs, index them, don’t rename | Renames break citations/links; fragmentation is documentation problem, not file-deletion problem |
| 2026-08-25 | Backfill provenance for audit/comparison | Required Artifacts rule: every run must leave final + provenance; web fetch blocked is valid provenance |
| 2026-08-25 | Drafts stay 7 days then archive, not delete now | Preserves verification trail; `outputs/.drafts` is expected per deep-research workflow |

## Summary for User

11 md files across 3 slugs for 1 repo → fragmentation, duplicate plans, drafts exposed, provenance gaps (2 finals lack sidecar), no outputs index. Plan is to add `outputs/README.md` + provenance sidecars + cross-links, document naming, and propose 7-day draft archive — no deletions yet.

Reply “yes” to execute O1–O3 (docs-only, low risk), or tell me what to change. Draft archive (O4) stays opt-in.
