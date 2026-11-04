# overseers: how the Overseers and the Project Assistant watch, act and hold back

There are three. The Overseer watches all of Sova and needs no project. A Project Overseer watches one project. The Project Assistant talks to an organization's owner. None of them can run in Create, and a chat can't start one in it.

The project ones need a project: in a folder that isn't one, offer Add as Project (the `project` topic). These settings are Sova's own, so they work with no merge queue and outside Git. Before a change to one that reaches people or the code, say what it lets happen without the person.

## What a Project Overseer may do without you

- Change: its switches, each On or Off, in two columns: the overseer on its own, and the Project Assistant from a client. Powers: `gather`, `whatsapp`, `ownerUpdates`, `roster`, `promote`, `bookkeeping`, `codingStart`, `codingPrompt`, `onboard`, `markMerged`, `copiesRun`, `copiesReset`, `share`, `deploy`, `release`. The Assistant's column has only `gather`, `codingStart`, `codingPrompt`, `copiesRun` and `deploy`.
- Lives: Sova's own settings for the project.
- Approves: the person's own click in the page: Apply on the card, or the switch on the Settings tab. The Overseer can also turn one On, in a turn the person started. Every other caller needs that click. Each power turned On is marked on the card with what it allows.
- By: Card or Screen. `overseer.powers`, proposed as the `overseer` setting with `powers`. The project page's Settings tab has the same switches.
- Live: from its next tool call.
- Check: the Settings tab shows the switch, and Settings history lists the change with Undo.

## Watch, pace and hold

- Change: whether it looks on its own, how often, how soon after a reason to look, and how long what reaches a person or the code waits in Needs you. A brake stops every power until Resume.
- Lives: Sova's own settings for the project.
- Approves: the person, by Apply. Watch on, a quicker pace, a shorter hold and Resume are marked as grants.
- By: Card or Screen. `overseer.watch`, `overseer.pace`, `overseer.hold` and `overseer.brake`, proposed as the `overseer` setting. The default is a look at most every 10 minutes, soon-looks after 60 seconds, a 10-minute hold.
- Live: now, once applied.
- Check: the Settings tab shows them. Its status line says what it has used today.

## Limits

- Change: what it may start or send per message of the person's, per day on its own, and at once. Unlimited is allowed for the allowances, never for the two at-once limits.
- Lives: Sova's own settings for the project.
- Approves: the person, by Apply. A limit raised is marked as a grant.
- By: Card or Screen. `overseer.limits`, proposed as the `overseer` setting, or the Settings tab's Limits section.
- Live: now. Raising a limit releases what was waiting on it.
- Check: the Limits table shows the value.

## Its models, instructions, abilities and memory

- Change: the models it runs on, extra instructions added to its prompt, its gathering abilities, and its memory switch.
- Lives: Sova's own settings for the project.
- Approves: the person, by Apply. Changed instructions and changed abilities are marked as grants.
- By: Card or Screen. `overseer.models`, `overseer.extra` and `overseer.abilities`, proposed as the `overseer` setting; `overseer.memory`, proposed as the `memory` setting.
- Live: from its next run.
- Check: the Settings tab shows them, and Settings history lists each change.

## The Overseer

- Change: its proactivity, model and thinking, its 8 limits, quick actions, standing notes, idea explorer, extra instructions, and whether it resumes interrupted runs.
- Lives: this computer. It doesn't spread.
- Approves: the person, by Apply or Save Changes.
- By: Card or Screen. The Sova-wide setting `overseer.global`, or Settings → Overseer. Standing notes have no card: they're on that tab.
- Live: the model when it's idle, or at the end of its turn; notes and instructions from its next run.
- Check: Settings → Overseer shows them.

## Approvals the Overseer holds

- Change: an approval for later, or a standing rule, that lets its unattended runs act on named sessions. Separately, when the Overseer turns on a project mode, that counts as the approval of the mode's tools and commands, never its hooks, and nothing waits for the person. Every other caller needs the person's click in the page. Tell them this before they let the Overseer run a project's modes.
- Lives: the Overseer's own conversation.
- Approves: the person, by a click on the card option the Overseer proposes. Words typed in chat never make an approval.
- By: Screen. They're made on the Overseer's cards and ended under Approvals & Schedules on its page. You can't make or end one.
- Live: now, from the next tool call.
- Check: Approvals & Schedules lists each live one with what it allows.

## The Project Assistant

- Change: the model that writes its replies, the model for coding sessions it starts, and the model for feature request chats. A project can set its own coding and gathering models. It has no instructions of its own to edit: the nearest way is the owner page's controls.
- Lives: a default on this computer, an organization's own pick in its workspace, and a project's pick in Sova's settings for it.
- Approves: the person.
- By: Card or Screen. The default is the Sova-wide setting `assistant.default`, or Settings → Organizations; a project's is `overseer.assistant-models`. An organization's pick is on its Owner card, with no card of Create's.
- Live: from its next read: replies, fixes and feature request chats all follow it.
- Check: the Owner card shows each model and whether it's ready.

## Organizations and gathering chats

- Change: an organization's About text, hours, workspace repository, number and login; limits for gathering chats, photos and files. Gathering chats can't use Create.
- Lives: the organization's workspace and this computer.
- Approves: the person.
- By: Screen. The organization's Settings tab, and Settings → Organizations.
- Live: new gathering chats for the message limit; the next upload for photos and files.
- Check: the same screens show them.
