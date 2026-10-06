# The spec system's own docs

Read these when you change the spec system: the tools in `../core/`, the drafts workflow, the
`spec` minor mode, or the replay harness in `../tests/replay/`. Nothing here is loaded into an
agent's context. The text an agent works from is `../../mode/spec-mode.md`, and the tools'
reference is `../core/README.md`, `../DRAFTS.md` and `../PROMOTE.md`.

| File | What it holds |
|---|---|
| [GOALS.md](GOALS.md) | What the spec system is for: goals G1–G6 and constraints C1–C5. A change to the tools names the goal it serves and is measured against today's tools. |
| [MODE.md](MODE.md) | The `spec` minor mode end to end: each piece, where it lives, and how they connect. |
| [EVOLUTION.md](EVOLUTION.md) | What the system was at the pinned baseline, what was measured, each milestone and its numbers, what was tried and rejected, and what is still open. |
| [CHANGELOG.md](CHANGELOG.md) | One entry per change that reached master, and how another project upgrades. |

The hashes in EVOLUTION.md and CHANGELOG.md are master commits, with two exceptions:
- CHANGELOG's "Integration → master" table maps the old work-branch merges to the master commits
  that re-applied them;
- "the b1de66b1 record" names a harness data file, `g-baseline-b1de66b1.json`, not a commit.
