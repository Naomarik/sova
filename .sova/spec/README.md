# .sova/spec: Sova's product documentation

This directory is the requirement for what Sova does. The prose lives in `claims/`, one file per
document, under `§` IDs (foldaidev's grammar). `manifest.json` holds each ID's kind, relations
and labels. [USAGE.md](USAGE.md) has the commands.

## Authority

- **Current documentation** is `manifest.json` plus `claims/`, and nothing else.
- **Migrated, not verified.** The committed root `spec/*.md` documents were ported here on
  2026-09-23. Their prose was kept whole, and only the headings changed, to carry IDs. Their
  records say `"authority": "migrated", "evidence": "unreviewed"`. The text carries the
  requirement it had in `spec/`. Nobody has checked the code against it since the move, so a
  migrated claim is not evidence that a feature works. The migration's parity check shows the
  text was carried over intact, and nothing about the code.
- **The old paths are redirects**, not a second authority. `spec/*.md` point here. Old paths,
  H1/H2 headings and `§N` citations resolve through `migration/legacy-map.json`, including those
  in source comments, which are never rewritten. A deeper heading kept its text, so search for
  it in the new file. `spec/brainstorms/` is research, not requirement.
- **The pilot is history.** Its manual Stage A candidates are archived byte-exact in
  `migration/pilot/`. `§chat/composer` keeps its ID, now with the migrated text. The pilot's
  other IDs are retired, their successors are listed in the legacy map, and they are never
  reused. `pilot/` and `reviews/baseline/` are that experiment's evidence and stay unchanged.
  Their references to `claims/*.md` mean `migration/pilot/claims/*.md`.
- **Proposals are drafts.** A proposed change is written in a full copy under `drafts/NAME/`,
  and never in `claims/` or `manifest.json`. An agreed draft is approved intent, not current
  behavior. Only the part that has been implemented and verified is promoted, and only
  explicitly. Edits that were uncommitted in `spec/` at migration time, and the untracked
  `spec/04i-playbooks.md`, are the draft `drafts/legacy-working/`, which is local only.
- **Baseline and feature stay apart.** Correcting the docs to match what the code already does
  is a change of its own. It is not mixed into a feature draft.

## Layout

| Path | What |
|---|---|
| `manifest.json` | One record per ID: `kind` (`surface`, `behavior`, `section`, `note`), `requires`, `members`, `code`, and the labels `authority` and `evidence`. Relations only; prose never. |
| `claims/<ns>/<name>.md` | One document. The H1 `# §ns/name — Title` is its lede, and each H2 `## §ns.name/slug — Title` is a child. Plain H3 and deeper are prose inside that child. |
| `migration/` | The port: `legacy-map.json`, `inventory.json` with hashes, the exact original bytes in `legacy/head/` (HEAD `c4d7993`) and `legacy/worktree/` (uncommitted variants), the archived pilot, and the transform and parity scripts. [migration/README.md](migration/README.md) explains them. |
| `drafts/` | Proposed changes, one full copy per draft. Local only. |
| `reviews/` | Review packets and records; `reviews/baseline/` holds the pilot's frozen inputs. Local only. |
| `pilot/` | The Stage A pilot's report, findings and planning comparison. Local only. |
| `tools/` | Vendored copies of the tools. Check their hashes first ([USAGE.md](USAGE.md)). |

## Reading a claim

- A missing `requires` key on a behavior means not investigated, and `[]` means none declared.
  Most migrated behaviors have no `requires` yet, so `check` exits 1 and lists them. The few
  edges there are quote the migrated prose, and `migration/legacy-map.json` lists them.
- `code` lists evidence locations, not complete specifications.
- `evidence` is what a person or a promotion recorded. No tool derives it, and no tool checks
  that prose and code agree in meaning.
- Source code carries no `§` IDs or spec annotations, and none are added.

## Publishing

`.gitignore` keeps local-only material out of commits. It stays on disk, and is never deleted:
`pilot/` (session metrics and paths), `reviews/` and `drafts/` (verbatim copies of source), and
`migration/legacy/worktree/` (edits that were never committed). Everything else here is meant to
be committed.

Commit by explicit path, never `git add -A` or `git add .`. The docs, the tools, the redirect
stubs and the instructions that point at them go in together, so no link lands dangling:

```sh
git add .sova/spec/.gitignore .sova/spec/README.md .sova/spec/USAGE.md .sova/spec/manifest.json \
  .sova/spec/claims .sova/spec/tools .sova/spec/migration spec/*.md pi-config/extensions/spec
git add -p CLAUDE.md CONTRIBUTING.md pi-config/README.md pi-config/extensions/mode \
  .claude/skills/fold-ai-dev-design/SKILL.md .claude/skills/fold-ai-dev-design/.build/audit.mjs
git diff --cached --stat
```

`migration/` must go in whole, minus the ignored `legacy/worktree/`. Its parity check,
`node .sova/spec/migration/verify.mjs`, needs `legacy/head/`, both JSON files, `pilot/` and the
scripts. Here it exits 0, full parity. A clean clone lacks the local-only bytes, so there it
checks the current docs fully but can't rebuild the draft, and exits 3, partial, naming what it
couldn't check ([details](migration/README.md#checking-the-record)). `legacy-map.json` and
`inventory.json` do list the draft's headings (including `spec/04i-playbooks.md`'s) and the
hashes of the uncommitted files, though no body text.

The second line is `-p` because those files may carry unrelated edits from other sessions. Review
the staged list before committing, and check it holds nothing from the local-only paths. Don't
add `spec/brainstorms/` with this change.
