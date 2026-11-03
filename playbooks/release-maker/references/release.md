# A project's release setup

Two parts, both on the maker's branch and landed together. Sova reads both from the target branch's tip.

## The settings: `.sova/project.json` → `release`

Parsed as strictly as the rest of the definition (Sova's own parser, `release-maker.mjs check`): an unknown key or a wrong type makes the whole file invalid. Absent: releases are not set up, and the Releases tab offers Set Up Releases. Outside the definition's hash.

```json
"release": {
  "playbook": ".sova/playbooks/release",
  "tag": "v${version}",
  "scheme": "semver",
  "channels": ["stable"],
  "commit": true,
  "checks": ["integration-group", {"id": "site-build", "label": "Site build", "run": ["pnpm", "--dir", "site", "run", "build"], "timeout": 900}],
  "quietMin": 30
}
```

| key | value |
|---|---|
| `playbook` | required: the project's release playbook folder (relative), holding `PLAYBOOK.md` and `release.json` |
| `tag` | the numbered tag's pattern, `${version}` exactly once, nothing else templated; default `v${version}`. Sova makes it at Publish and never moves it |
| `scheme` | `semver` (default: X.Y.Z, an optional `-pre`), `calver` (YYYY.MM, optional .DD and .N) or `none`: how Sova checks the reported version |
| `channels` | 0 to 3 moving tags Publish moves to each new release (`stable`); never shaped like a numbered tag. Withdraw moves them back |
| `commit` | `true` (default): the release makes a commit (its `commit` step) that lands through the merge queue; `false`: tag-only, the release is of the target's tip at Start Release |
| `checks` | release-only gating checks the queue runs on the release entry after its required checks, in order: a merge check's id (an optional one included), or one declared here `{id, label?, run, timeout?, rerun?, requires?}` (never `optional`). A failed one holds Publish; nothing overrides it |
| `quietMin` | 5 to 1440 (default 30): minutes without a report from the release chat, while the target is frozen, before Needs you says so |

Whether Publish pushes follows the merge queue: it pushes the target, the tag and the channels to `origin` in one atomic push unless `merge.push` is `false` or there is no `origin`; then it tags and moves the channels on this machine only. There is no key for it.

## The step list: `<playbook>/release.json`

```json
{
  "v": 1,
  "steps": [
    {"id": "version", "label": "Pick the version", "phase": "prepare"},
    {"id": "notes", "label": "Write the release notes", "phase": "prepare"},
    {"id": "bump", "label": "Bump the version files", "phase": "prepare"},
    {"id": "commit", "label": "Make the release commit", "phase": "prepare"},
    {"id": "release-page", "label": "Publish the release page", "phase": "after"}
  ]
}
```

- `id`: lowercase letters, digits and hyphens, starting with a letter, at most 31; unique. `checks`, `publish`, `withdraw` and `abandon` are Sova's own and never declared.
- `label`: what the Releases tab shows, 1 to 60 characters.
- `phase`, listed in this order: `prepare` (before Sova's checks: the number, the notes, the bumps, the release commit), `check` (after the checks passed and the release commit landed on the frozen target, before Publish: a live try-out), `after` (after Publish: a release page, a registry, building the app) or `withdraw` (after a Withdraw: the release page marked withdrawn). At most 30 steps.
- `held: true`: the step ends held until the operator's Continue (a live try-out, a look by hand).
- `artifact: true`: its done report must carry an artifact's facts (`artifact=<path>`, `sha256=`, `size=`): a built release kept outside the repository or under an ignored path.
- With `commit: true`, a prepare step with the id `commit` makes the release commit and reports it with its `commit=` fact; Sova queues it from that report. With `commit: false`, there is no `commit` step.

Sova draws the release's plan from this file at Start Release: prepare steps, Sova's `checks`, check steps, Sova's `publish`, after steps, and withdraw steps (run only after a Withdraw). Nothing else adds a step.

## The playbook: `<playbook>/PLAYBOOK.md`

The release chat reads Sova's general method first, then this file; this file wins where they differ, except Sova's gates (the freeze, Publish, Withdraw, who may do each). It holds what is particular to the project, nothing general:
- **Version rule**: how the chat picks the number alone, for every case.
- **Notes**: where they go, their heading, audience and style.
- **Steps**: one section or bullet per `release.json` id, naming it in backticks (`check` refuses a step the playbook never names), with the exact commands.
- **Release-only checks**: what the settings' checks cover, in words.
- **After publishing**: each after step's commands. A release page is made only with `gh release create --verify-tag` (the tag exists once Sova published).
- **Artifacts**: where the built files go (`release.mjs artifact <path>` reports them), outside the repository or under an ignored path.

Its own scripts live in `scripts/` beside it; Sova's general script is `release.mjs` in Sova's Release method folder (`status`, `notes`, `changelog`, `bump`, `artifact`).

## The starter

What `release-maker.mjs init` writes, and what Sova offers as the default answer to each question:
- settings `{"playbook": ".sova/playbooks/release", "tag": "v${version}", "scheme": "semver", "channels": ["stable"], "commit": true}` (`--no-channel`: no channels; `--tag-only`: `commit: false`);
- `release.json`: `version`, `notes`, `bump` (only with `--bump <file>`), `commit` (not with `--tag-only`); no after steps;
- `PLAYBOOK.md`: a semantic version rule (patch for fixes, minor for features, major for breaking changes, minor while 0.x), notes at the top of `CHANGELOG.md` (tag-only: in the release's notes only), and one bullet per step.

Every part is the project's to change. `init` never overwrites: it refuses when any part exists.

## What `check` refuses
Sova's parsers on both files, the canonical form (`fmt`), and in every file of the playbook folder (Markdown: the code in fences and in backticks; scripts: all of it):
- `git push`; `git tag` that creates, moves or deletes a tag; `git update-ref` on a tag or branch; `git reset --hard`;
- `gh release create` without `--verify-tag`; `gh release delete`;
- calling Sova (`sova-project`, `/api/project-services`, a token): reports go only through the release chat's `release.step`;
- `merge.pause` / `merge.resume`: the release freeze replaces them;
- a literal IP address or a secret-looking value;
- a `scripts/…` or `references/…` path the folder doesn't have; a step id `PLAYBOOK.md` never names;
- an artifact path (`release.mjs artifact <path>`) inside the repository that git doesn't ignore, or an `artifact: true` step the playbook gives no path for;
- `commit: true` without a prepare step `commit`, or `commit: false` with one.
