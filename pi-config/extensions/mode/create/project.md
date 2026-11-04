# project: how your project runs, tests, shares and ships

Everything here needs a project. In a folder that isn't one, say what's missing and offer Add as Project first (see Adding a project). In a project with no merge queue, a worker makes the change in a worktree and the branch is the person's to merge, by "merge it" in their own message; say so, and offer Initialize (the `landing` topic). In a folder that isn't in Git, say project changes are made by hand: no card and no branch can carry them.

Choosing between a card and a branch: `.sova/project.json` is one file, but it decides how the project runs. When the project has checks, it goes by Land, because a card lands with no checks. With no checks, a card is fine.

## Adding a project

- Change: make a folder one of Sova's projects, which gives it a project page, a Project Overseer and cards.
- Lives: this computer's list of projects. A folder inside a Git checkout is added as that checkout's root.
- Approves: the person, by adding it.
- By: Screen. Add as Project on the chat's Session tab, or Add Project on the Projects page. Clone from GitHub is there too. Nothing registers on its own.
- Live: now.
- Check: the Session tab's Project row links to the project's page. It doesn't spread to other computers.

## How the project runs

- Change: the services a copy runs, their ports, what must be ready, setup steps, data, the entry point people open, the copy default, and the checkout files the definition was written from. Keys: `services`, `setup`, `data`, `open`, `slots`, `host`, `hooks`, `sources`.
- Lives: `.sova/project.json` at the root of the project. Each branch carries its own. Parsed strictly: one unknown key or wrong value voids the whole file. Commands are lists of arguments, never a shell string.
- Approves: the person, by Land, or by Apply and Approve on a card: any change to this file counts as a grant, because it decides what runs on this computer.
- By: Land or Card. Land when the project has checks. The card is the `services` setting and holds the whole file.
- Live: after landing, for the next copy that starts; a running copy takes it at its next `apply`.
- Check: have the worker run `project_verbs` with `conform` in its worktree, then look at the project page's Branches tab. It spreads only through Git.

Smallest working file, a static site:

```json
{"version": 1, "services": {"site": {"static": ".", "ports": {"http": {"base": 8731}}}}}
```

## Tests

- Change: the project's test command, what it needs running first, and the small selection that proves a copy works. Key: `test`, with `run`, `requires`, `timeout` and `smoke`.
- Lives: `.sova/project.json`, as above.
- Approves: the person, as above.
- By: Land or Card. Land when the project has checks.
- Live: after landing. A branch's own test command runs in that branch's copy before that.
- Check: have the worker run `project_verbs` with `test`.

Add this beside the file's other keys. `smoke` names 1 to 50 selectors that pass on the main branch:

```json
{"test": {"run": ["npm", "test"], "smoke": ["test/smoke.test.js"]}}
```

## Sharing a running copy

- Change: which ports of a running copy may get a preview link, and for how long. Key: `share`, with `endpoints`, `maxDays` and `allow`. A copy holding data marked `sensitive` is never shared.
- Lives: `.sova/project.json`, as above. The links themselves live on this computer.
- Approves: the person, for the file as above. Making a link is the person's, confirmed on the Branches tab, or the Project Overseer's under its `share` power. A chat can't make one, and can't see one's address; it can only end a link.
- By: Land or Card. Land when the project has checks. This also needs a preview address (the `computers` topic).
- Live: after landing; then a link can be made for a copy that is running.
- Check: the Branches tab offers Share for that copy. Without a `share` key, no copy is shared.

Each endpoint is `<service>.<port>`, a port of a service the file declares:

```json
{"share": {"endpoints": ["site.http"], "maxDays": 3}}
```

## Shipping

- Change: the recipe that ships the project to production or staging: where, what it needs, its steps, how to verify it and how to roll back. Key: `deploy`, with `targets`.
- Lives: `.sova/project.json`, as above. Host values and credential values live on this computer in Sova's own host file, never in the project: the person sets those.
- Approves: the person, for the recipe as above. Shipping is the person's, from the project page's Deploy panel, or the project's `deploy` power. A chat never ships and never asks to.
- By: Land or Card. Land when the project has checks. Never put a credential's value in the file: it names the variable only.
- Live: after landing, from the next plan. A plan lasts 15 minutes and runs once.
- Check: have the worker run `project_verbs` with `deploy.check`. It runs nothing and contacts nothing; it says whether the recipe parses and what's missing here.

One target. `rollback` is required; `{"none": "<reason>"}` is the way to have none:

```json
{"deploy": {"targets": {"production": {
  "about": "The public site.",
  "steps": [{"id": "publish", "run": ["./publish.sh"]}],
  "verify": {"http": "https://example.com/"},
  "rollback": {"none": "Publish the previous commit by hand."}
}}}}
```

## Project name

- Change: the name Sova shows for the project.
- Lives: Sova's own settings for the project, not the project's files.
- Approves: the person, by Apply.
- By: Card. `project.name`, proposed as the `project` setting with `name`.
- Live: now, once applied.
- Check: the project's page shows it, and its Settings history lists the change with Undo.

## An organization's project

- Change: its main stakeholder, whether it shows on the owner's page, and whether its spec is frozen. A project in no organization has none of these.
- Lives: Sova's own settings for the project.
- Approves: the person, by Apply. Showing it on the owner's page again and unfreezing the spec are marked as grants.
- By: Card. `project.stakeholder`, `project.ownerHidden` and `project.frozen`, proposed as the `project` setting.
- Live: now, once applied.
- Check: the project page and the owner's page show it.

## Copy limit

- Change: how many copies of the project may run at once on this computer, 1 to 16. Without it, the file's `slots` cap applies, 4 by default.
- Lives: this computer. It doesn't spread.
- Approves: the person, by Apply. Raising it is marked as a grant on the card.
- By: Card. The `copies` setting with `limit`, or null to go back to the file's value. The Branches tab has the same control.
- Live: now. Lowering it stops nothing that's running.
- Check: the Branches tab shows the limit and where it comes from.

## Moving or archiving the project

- Change: the project's folder, or whether it's archived.
- Lives: this computer's list of projects.
- Approves: the person, on the project page, archiving with its own confirm.
- By: Screen. The project page. No card holds these: `project.archive` is the person's.
- Live: now.
- Check: the project page shows the new folder, or the Projects page lists it as archived.
