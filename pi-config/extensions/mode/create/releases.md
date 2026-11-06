# releases: numbered versions of your project, and how they're made and published

Everything here needs a project with a merge queue that lands locally: a project that lands by request or by pushing a branch can't release yet, so say so and name How it lands in Settings → Merge Queue (the `landing` topic). In a folder that isn't a project, offer Add as Project (the `project` topic). With no queue, offer Set Up with a Chat. In a folder that isn't in Git there are no releases.

Recommend Set Up with a Chat on the Releases tab for a project with none: the project's Setup chat reads the project, asks how it releases, draws each step and who does it, and proposes everything on a branch (the landing and deploy setup too, when the person wants them). A release is not a deploy: a release is a numbered name others pull, never moved or deleted once public; a deploy runs a version somewhere you operate (the `project` topic). You never start, publish, abandon or withdraw a release.

## Setting up releases

- Change: whether the project has releases at all, with a release playbook and a `release` section written to fit it.
- Lives: the project page's Releases tab starts it. The result lands in the project: a `release` key in `.sova/project.json` and a playbook folder.
- Approves: the person: Set Up with a Chat (Change Setup once set up), their answers, then Land.
- By: Screen. The Releases tab, Set Up with a Chat. The project's Setup chat proposes on its own branch, trial-runs the release checks it adds or changes, and the person lands it.
- Live: after landing. Sova reads the section from the merge queue's target, never a working folder.
- Check: the Releases tab loses its Not set up chip and shows Start Release.

## Release settings

- Change: the tag's pattern, how a version is checked, the moving tags Publish moves, whether a release makes a commit, extra checks and how long a quiet release waits. Key: `release`, with `playbook` (required), `tag`, `scheme` (`semver`, `calver`, `none`), `channels` (up to 3), `commit`, `checks` (up to 20) and `quietMin`.
- Lives: `.sova/project.json`, read from the merge queue's target. It's parsed strictly, so a wrong value voids the whole file. No key names a remote: whether Publish pushes follows `merge.push` and `origin`.
- Approves: the person, by Land, or Apply and Approve on a card: any change to this file is a grant.
- By: Land or Card. Land when the project has checks. The card is the `services` setting and holds the whole file.
- Live: after landing, from the next Start Release. A release already started keeps what it captured.
- Check: the Releases tab reads them, or shows "This project's release settings don't read."

Beside the file's other keys:

```json
{"release": {"playbook": ".sova/playbooks/release", "tag": "v${version}", "scheme": "semver", "channels": ["stable"], "commit": true}}
```

## The release playbook

- Change: the project's own steps: picking the number, notes, bumps, the release commit, a live try-out, after-publish steps.
- Lives: the folder `release.playbook` names: `PLAYBOOK.md`, its scripts, and `release.json`, the steps. A step is `{id, label, phase, held?, artifact?}`; `phase` is `prepare`, `check`, `after` or `withdraw`, in that order. `commit`, when there, is the last prepare step, and `version` reports the version. Sova's own ids (`checks`, `publish`, `withdraw`, `abandon`) are refused. A step must never push, tag or move a branch: Sova does that at Publish.
- Approves: the person, by Land.
- By: Land, through Change Setup on the Releases tab: the project's Setup chat changes the folder on its own branch. A card can't carry the folder.
- Live: after landing, from the next Start Release.
- Check: Start Release shows the plan, with Sova's `checks` and `publish` among the steps.

```json
{"v": 1, "steps": [
  {"id": "version", "label": "Pick the version", "phase": "prepare"},
  {"id": "notes", "label": "Write the notes", "phase": "prepare"},
  {"id": "commit", "label": "Make the release commit", "phase": "prepare"}
]}
```

## Releases-only deploy targets

- Change: make a deploy target take only published releases. Key: `releases: "only"` on a target under `deploy.targets`.
- Lives: `.sova/project.json`.
- Approves: the person, as for the file.
- By: Land or Card. Land when the project has checks.
- Live: after landing, from the next plan: a commit that isn't a published release is refused.
- Check: plan a deploy of a branch tip on the Deploy card, and see it refused.

## Cutting a release

- Change: nothing is configured: this is the release itself. Start, Continue, Retry, Publish, Abandon, Withdraw. While it's open the merge queue is frozen.
- Lives: the project page's Releases tab, with a record of every release.
- Approves: the person, on that tab, with a confirm for Publish, Abandon and Withdraw. An overseer with the `release` power may start and publish after the waiting period; it can't override a failed check.
- By: Screen. The Releases tab. Name it: you never run these. A chat's script is refused by its caller key, which is the limit of that refusal: a token with no caller key can't be told from the person's own terminal.
- Live: at Publish. Once public, a release's tag is never moved or deleted. Withdraw marks it withdrawn and moves its channels back; it doesn't roll back a deploy.
- Check: the tab shows each step and the latest release.

## Letting the overseer release

- Change: whether the Project Overseer may start and publish on its own. The Project Assistant has no such power.
- Lives: Sova's own settings for the project.
- Approves: the person's own click in the page: Apply on the card, or the switch on the Settings tab.
- By: Card or Screen. `overseer.powers`, with `release`.
- Live: from its next tool call. It waits the project's hold, cancellable in Needs you.
- Check: the Settings tab shows the switch.
