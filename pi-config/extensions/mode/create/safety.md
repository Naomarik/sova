# safety: what agents may touch, and who approves what

Sandbox states limit what a chat's tools can do to this computer. Approvals are the person's decisions that let something act later without asking. You never give one: stop, say what it allows, and name where they click.

## Chat sandbox

- Change: how confined one chat and its workers are.
- Lives: that chat, in the Sandbox rows of its composer. It starts in Subagents only, and nothing carries a choice to another chat.
- Approves: the person. The agent has no tool for it, and you never change it. The Overseer may set it, and lowers it only in a turn the person's click on its card opened.
- By: Screen. The Sandbox rows in that chat's composer.
- Live: next tool call for the chat. A worker takes it when it starts or resumes.
- Check: the shield in the composer shows the state.

| State | The chat's own tools | A worker in the chat's worktree | Any other worker |
|---|---|---|---|
| Off | Unconfined | Unconfined | Unconfined |
| Subagents only (the start) | Unconfined | Writes only in that worktree | Unconfined |
| On | Sandbox | Sandbox, narrowed to that worktree | Sandbox |

With On, files outside the chat's folder and its worktrees are read-only, the agent folder is read-only, credentials are hidden, the network goes through an allowlist, and the chat can't reach Sova at all. So a chat with the sandbox On can't write files on this computer, reach Sova's commands, or run project tools, and it says so first.

Be exact about what it is: containment for an agent's mistakes on a single-user computer, not a wall against hostile code. It confines tools, not the chat's own process, so add-ons aren't confined. It doesn't reach what the person later runs from what the agent wrote: `npm run`, `make`, an editor task. Reviewing the changes first is the control there.

## Machine sandbox policy

- Change: what On means on this computer: `level`, `defaultOn`, `writable`, `hidden`, `shadowed`, `readOnlyWithinWritable`, `proxy`, `env`, `acceptPartial`.
- Lives: this computer, in `<agent dir>/sandbox-policy/<platform>/policy.json`, where the platform is `linux` or `darwin`.
- Approves: the person, with Apply and Approve on the card, in their own page. Every change to it is a grant. It reaches every chat, so say which keys widen and for whom.
- By: Card. Propose `{setting: "sova", id: "sandbox.policy", value: <the whole policy.json>}`; `sova_settings` reference gives its shape. You only prepare it: this is no way around lowering a sandbox.
- Live: next tool call, in every chat.
- Check: `/sandbox` in a chat reports the state; try the path or host that changed.

A malformed policy makes every sandboxed tool refuse until it's fixed. Prefer `shadowed` to `writable` for caches, because what's written to `writable` lands on the real folder.

## Project tightening

- Change: make the sandbox stricter for one project: lower `level` to `read-only`, add `hidden` paths, or remove proxy hosts, `writable` roots or `shadowed` paths.
- Lives: the project, in `<project>/.sova/sandbox.json`. It can only tighten: a loosening key is ignored with a notice.
- Approves: the person, by Land.
- By: Land.
- Live: next tool call in a chat in that folder, once it has the file.
- Check: a tool in that chat with the sandbox On refuses the tightened path, and no notice names an ignored key.

## Who approves what

- Change: nothing here. This is who decides each approval, for when another topic reaches one.
- Lives: each approval's own place, in the list below.
- Approves: the person, by a click in Sova's page on this computer, but for the Overseer's two exceptions below.
- By: Screen. Name the control and wait for the person. A refused request says where they click: pass that on, and change nothing else.
- Live: as each topic says.
- Check: the control shows the new state.

Only the person's own click passes these. Sova refuses a chat, a script, an extension's backend and another computer, and the refusal names the click:

- A project's run buttons: Approve Run Buttons on the project page's Offers list.
- A profile's powers: Approve in Settings → Profiles or on the profile picker.
- A schedule: Approve in the Playbooks dialog or the Overseer's Approvals & Schedules. A schedule on another of the person's computers can be approved from this page too.
- Turning on a Project Overseer power: its switch on the project page's Settings tab.
- Lowering a chat's sandbox: the Sandbox rows in that chat's composer. A `/sandbox` that lowers passes only typed in the page's composer, never sent by a program.
- A project tool: Approve and Turn On in that chat's mode menu.
- A project mode's hooks: Approve Hooks in that chat's mode menu.
- A Settings change card: Apply or Apply and Approve on the card, and its undo.
- Landing a branch: Land.
- Trusting cards: the Trust button on the card, for a project's or an extension's cards.

Narrowing stays open: turning a power off, raising a sandbox, turning a mode off, and turning on a version already approved need no click. Create still only prepares a card, even for a change that narrows.

What the Overseer keeps: its turning a project mode on counts as its approval of that mode's tools and commands, never its hooks; in a turn the person started it can turn a Project Overseer power on; and it lowers a chat's sandbox only in a turn the person's click on its card opened. No other agent has these.

Add-ons, Sova extensions and a project's own add-on files ask nothing, so the person's OK before you write one is the only check there is. Say so first.

## How strong a click is

- Change: nothing. This is what to say when someone asks how far to rely on these approvals.
- Lives: nowhere: it's how Sova tells the person's page from a program.
- Approves: nobody.
- By: None. Nothing to change.
- Live: always.
- Check: there's nothing to check.

It raises the bar; it isn't a wall. The approvals stop a chat following its instructions, not a program on this computer deliberately posing as the person's browser. The same local route passes every approval on this list, and a chat whose own tools aren't sandboxed, which is the default state, can reach it. So don't tell anyone an approval holds against code running on their computer. The refusal stops the ordinary road and tells the chat where to send the person. A chat with the sandbox On at full enforcement can't reach that route. Weaker enforcement hasn't been tested, so say so. Never try to get past a refusal: ask the person.

<!-- Interim (D16, q22): one sentence, on its own, so it's easy to remove. -->
An installed Sova extension's page runs in Sova's own page, so what it does passes as the person's click and installing one is a trust decision: say so before their OK.

## Worker priority

- Change: how far below other work on this computer workers and tool commands run.
- Lives: this computer, as `workerNice` in `<agent dir>/sova/settings.json`: a niceness from 0 to 19, 10 by default, and 0 turns the lowering off. `SOVA_WORKER_NICE` in the server's environment wins over it.
- Approves: the person, with Apply.
- By: Card. Propose `workers.priority`; `sova_settings` reference gives its shape. It reaches the person's other computers when sync is on, so say so before Apply.
- Live: next worker start.
- Check: `sova_settings` get shows the value, and a new worker's process runs at that niceness.
