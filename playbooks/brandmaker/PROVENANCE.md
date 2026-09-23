# Provenance

- **Source path:** `/home/naomarik/github/rakiba/ai/brandmaker/`
- **Source repo remote:** `origin git@github.com:Naomarik/rakiba.git` (fetch and push)
- **Source commit (last touching `ai/brandmaker`):** `d76efa066e6265a0c5ee964c4def2fde2ba94289` — 2026-08-06 — "docs(brandmaker): fix defects surfaced by two autonomous playbook runs". The source working tree had no uncommitted changes under `ai/brandmaker` at copy time.
- **Copy date:** 2026-09-23
- **Copied set:** 15 files, 61,991 bytes (`du -sh`: 88K). Copied byte-for-byte with `cp -a`; the only file added at copy time was this `PROVENANCE.md` — `LOCAL-DELTAS.md` came later.

This is a point-in-time snapshot. The copy in the rakiba repo remains the authority, and re-vendoring is how this copy is updated. Divergence between this copy and rakiba's is expected and is not itself a defect.

`LOCAL-DELTAS.md`, beside this file, records the intentional divergences between this playbook and the skill Sova ships at `.claude/skills/fold-ai-dev-design/`, and (row 7) between this copy and rakiba's — read it before auditing that skill against `PARITY.md`.

**Moved 2026-09-23** from `ai/playbooks/brandmaker/` to `playbooks/brandmaker/`, the catalog Sova ships (`server/playbooks.ts` lists every `playbooks/<id>/PLAYBOOK.md`). The move added one thing to the snapshot: a `---`-fenced frontmatter block (`title`, `description`, `promptHint`) at the top of `PLAYBOOK.md`, which the catalog reads and strips before the body is sent. Everything below that block was still the byte-for-byte copy at the move, 6 lines lower than in rakiba's — see the divergence below.

**Diverged 2026-09-23:** `phases/07-install.md` was rewritten to install into any project rather than only a Rakiba one, and `PLAYBOOK.md`'s mode-routing line and phase-table row for 07 were changed to match. Those are the only edits to the copied text; every other copied file is still byte-for-byte. Why, and what changed, is row 7 of `LOCAL-DELTAS.md`. A re-vendor from rakiba overwrites all three and must reapply them.

Nearby in this repo: `ai/branding/playbooks/` holds unrelated Sova product playbooks (`derive-website.md`, `explain-feature.md`, `readme-update.md`). None is named `PLAYBOOK.md`, and none is in the catalog.
