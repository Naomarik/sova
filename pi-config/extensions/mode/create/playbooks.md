# playbooks: repeatable jobs with a cast, your choices and steps, and how to make one

A playbook is how one job is done, written once and run again: its recipe, and optionally who runs it on which models, what the person chooses, and where it stops for them. Recommend one for any job the person runs by hand more than once. A one-page recipe needs only its `PLAYBOOK.md`; add a `playbook.json` when the job has helpers, models, choices or stop points.

This entry is the contents page. Open a section only when you need it, with `create_guide` and both `topic: "playbooks"` and its `section`:

{{SECTIONS}}

Make a playbook from what the person describes, from this chat, or from their past chats: read what you need first, then write the files, show them, and save them as below.

## Your own playbooks

- Change: a playbook in all the person's chats on this computer, optionally replacing a shipped one with the same id.
- Lives: `<agent dir>/sova/playbooks/<id>/`: `PLAYBOOK.md`, and beside it `playbook.json`, `roles/`, `phases/`, `references/` and `scripts/` as it needs. The id is lowercase letters, digits and dashes. Relative paths in it resolve against its own folder.
- Approves: the person, by their OK on every file.
- By: OK. Show the paths and every file whole first.
- Live: now: the Playbooks list and the `/` rows read the folder each time. It doesn't spread to other computers.
- Check: the composer's plus, Playbooks, lists it under Yours. One with a `playbook.json` opens its card, or shows the file's exact error instead.

## A project's playbooks

- Change: a playbook for everyone on the project.
- Lives: `<project>/.sova/playbooks/<id>/`, the same folder as your own. A folder written as a skill, with `SKILL.md`, works too. Sova never runs a playbook's scripts: the agent runs them under the chat's own permissions.
- Approves: the person, by Land or Apply.
- By: Land or Card. Land when it has more than its one `PLAYBOOK.md`, which it does once it has a `playbook.json`. The card is the `playbook` setting, with its id and the entry's text.
- Live: after landing, or once the card is applied, the next time the Playbooks list opens. A branch's copy does nothing.
- Check: the Playbooks list shows it under This project, and `/<id>` in the composer opens its card.
