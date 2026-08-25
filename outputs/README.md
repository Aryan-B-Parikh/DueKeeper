# Outputs — DueKeeper

**Repo:** `D:/DueKeeper` · **Primary slug family:** `duekeeper*` · **Last audited:** 2026-08-25

Start here. This folder holds 3 companion artifacts for **one repo** — they were produced with 3 separate slugs, so this index maps slug → purpose.

| File | Slug | What it is | Read when you want… | Status |
|---|---|---|---|---|
| `duekeeper-audit.md` | `duekeeper` | **Paper-vs-code audit** (AUDIT.md §3-§9 vs `server/src/*`, 6.8/10, C1-C4/H1-H8, 129/129 tests) | The verdict: what was wrong, what’s fixed, where the residual risks are | Final — see `duekeeper-audit.provenance.md` |
| `duekeeper-sources-comparison.md` | `duekeeper-sources` | **Sources comparison matrix** (AUDIT + README + ARCHITECTURE/API/DATABASE vs code, 14-row matrix, agreement/disagreement/uncertainty, Mermaid) | A source-by-source claim table with confidence + caveats | Final — see `duekeeper-sources.provenance.md` |
| `duekeeper-deep-research.md` | `duekeeper-deep-research` | **Deep research (cited)** — 5 questions, findings by theme, caveats, open questions, inline `path:line` citations + Sources | The citable synthesis (executive summary → Sources) | Final — `duekeeper-deep-research.provenance.md` (PASS) |

**Plans:** `outputs/.plans/{duekeeper.md, duekeeper-sources.md, duekeeper-deep-research.md}` + `outputs/.plans/outputs-improvement.md` (this cleanup). Each plan is the “before” for its artifact; they overlap ~70% because the topic is one repo — cross-links at top of each plan point to siblings (see *See also*).

**Drafts (ephemeral):** `outputs/.drafts/{duekeeper-deep-research-{research-direct,draft,cited,verification}.md}` — verification trail for the deep-research run. Safe to keep 7 days after delivery, then archive to `outputs/.archive/<date>/` (see `outputs/.drafts/README.md`). `cited.md` is byte-identical to `outputs/duekeeper-deep-research.md` by design.

**Naming convention (going forward):**
- Final: `outputs/<slug>.md` + `outputs/<slug>.provenance.md` (sidecar, `Verification: PASS/BLOCKED`)
- Plan: `outputs/.plans/<slug>.md`
- Drafts: `outputs/.drafts/<slug>-{research-direct,draft,cited,verification}.md` (ephemeral)
- Don’t derive a new slug for the same repo unless the question changes — reuse `duekeeper` family (`duekeeper-audit`, `duekeeper-comparison`, `duekeeper-research`) or dated `duekeeper-2026-08-25`.

**Provenance:** Every final now has a sidecar. Web fetch was `BLOCKED` in this harness (`default.read/bash/edit/write` only, no `web_search`/`fetch_content`/`alpha_search`), so external RFC/OWASP specs are paper-cited and verified only via `tests/push.test.ts` vector — noted in each provenance.

**Quick re-verify:**
```bash
cd server && npm run typecheck  # 0
cd server && npm test           # 129/33/0
cd web && npx tsc --noEmit     # 0
```

