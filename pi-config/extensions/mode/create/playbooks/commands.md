# commands: what Sova itself can do from a playbook

Sova's own actions are named commands: list chats, read a chat, start one and send it a message, stop one, run a project's services and tests, read the merge queue, and many more. A playbook's scripts and its main chat can use them, for example to start a test copy of Sova, wait for a chat to finish and read its result.

Find them; never copy the list into a playbook, it changes:

```sh
SOVA="$SOVA_CHAT_LIVE_ROOT"            # in a Sova chat; else where Sova is installed
node "$SOVA/scripts/sova.mjs" list               # every command, and whether it looks or changes
node "$SOVA/scripts/sova.mjs" describe session.send
node "$SOVA/scripts/sova.mjs" run session.read --session <id or path>
```

Commands that only look are free. Name the ones that change things in `commands` in `playbook.json` (`["session.create", "project.verb.up"]`), so the card shows them before Start: every changing command a script or a chat in the run uses, through `sova.mjs` or its request. A chat's own tools (its project tool, its worker tools) aren't commands and aren't listed.

Some actions pass only on the person's own click in Sova's page, never as a command: Land, Start on a card, approvals, and restarting or updating Sova. A playbook never tries them: it says where to click.
