# .sova/spec: Sova's product documentation

This directory is the requirement for what Sova does. The prose lives in `claims/`, one file per
document, under `§` IDs (foldaidev's grammar). `manifest.json` holds each ID's kind, relations
and labels. [USAGE.md](USAGE.md) has the commands.

## Authority

- **Current documentation** is `manifest.json` plus `claims/`, and nothing else.
- **`migrated` is not verified.** A record labelled `"authority": "migrated", "evidence":
  "unreviewed"` carries prose that is the requirement, but nobody has checked the code against
  it, so it is not evidence that a feature works.
- **Proposals are drafts.** A proposed change is written in a full copy under `drafts/NAME/`,
  and never in `claims/` or `manifest.json`. An agreed draft is approved intent, not current
  behavior. Only the part that has been implemented and verified is promoted, and only
  explicitly.
- **Baseline and feature stay apart.** Correcting the docs to match what the code already does
  is a change of its own. It is not mixed into a feature draft.

## Layout

| Path | What |
|---|---|
| `manifest.json` | One record per ID: `kind` (`surface`, `behavior`, `section`, `note`), `requires`, `members`, `code`, and the labels `authority` and `evidence`. Relations only; prose never. |
| `claims/<ns>/<name>.md` | One document. The H1 `# §ns/name — Title` is its lede, and each H2 `## §ns.name/slug — Title` is a child. Plain H3 and deeper are prose inside that child. |
| `drafts/` | Proposed changes, one full copy per draft. Local only. |
| `reviews/` | Review packets and records. Local only. |
| `tools/` | Vendored copies of the tools. Check their hashes first ([USAGE.md](USAGE.md)). |

## Reading a claim

- A missing `requires` key on a behavior means not investigated, and `[]` means none declared.
  Most migrated behaviors have no `requires` yet, so `check` exits 1 and lists them.
- `code` lists evidence locations, not complete specifications.
- `evidence` is what a person or a promotion recorded. No tool derives it, and no tool checks
  that prose and code agree in meaning.
- Source code carries no `§` IDs or spec annotations, and none are added.

## Publishing

`.gitignore` keeps local-only material out of commits. It stays on disk, and is never deleted:
`pilot/` (session metrics and paths), `reviews/` and `drafts/` (verbatim copies of source).
Everything else here is meant to be committed.

Commit by explicit path, never `git add -A` or `git add .`. The docs, the tools and the
instructions that point at them go in together, so no link lands dangling:

```sh
git add .sova/spec/.gitignore .sova/spec/README.md .sova/spec/USAGE.md .sova/spec/manifest.json \
  .sova/spec/claims .sova/spec/tools pi-config/extensions/spec
git add -p CLAUDE.md CONTRIBUTING.md pi-config/README.md pi-config/extensions/mode \
  .claude/skills/fold-ai-dev-design/SKILL.md .claude/skills/fold-ai-dev-design/.build/audit.mjs
git diff --cached --stat
```

The second line is `-p` because those files may carry unrelated edits from other sessions. Review
the staged list before committing, and check it holds nothing from the local-only paths.
