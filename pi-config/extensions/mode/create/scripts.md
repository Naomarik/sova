# scripts: drive Sova from your own program, and follow what happens

Nothing here changes Sova, so there's nothing to approve or apply. Help the person write their program, keeping it in their own folder or project. Sova's token is the person's whole reach: a program reads it from its file when it runs, and it never passes through you. Sova never calls anyone back, so there are no webhooks: a program that wants to hear what happens stays connected.

Scripts can't give the person's approvals: Sova refuses them and says where to click (`safety`).

<!-- Interim until q21: restarting and updating stay the person's. -->
A chat never runs `server.restart` or anything else that restarts or updates Sova, whoever asks. Name the control instead: Settings → General, where the person does it.

## Named commands

- Change: nothing. Run any of Sova's named actions from a program: rename, archive, send a message, run a project verb.
- Lives: `<sova folder>/scripts/sova.mjs`. The Sova folder is where Sova is installed, by default `~/.local/share/sova`; in a Sova chat it's `$SOVA_CHAT_LIVE_ROOT`. It needs Node 22.19 or newer. The installed `sova` command is a different program, so never tell anyone to type `sova run`: that starts the server.
- Approves: each command runs as the person. Approvals aren't commands.
- By: Terminal. A chat may run ones that only look; one that changes something needs `--session` named, and needs the person to ask for it.
- Live: now.
- Check: its exit code: 0 done, 1 failed, 2 refused, 3 invalid, 4 busy, and 5 outcome unknown for `chat.*` actions.

```sh
SOVA=~/.local/share/sova
node "$SOVA/scripts/sova.mjs" list
node "$SOVA/scripts/sova.mjs" describe session.send
node "$SOVA/scripts/sova.mjs" run session.send --session <id or path> --text "Run the tests"
```

It reaches this computer's Sova only: `--url`, else `$SOVA_URL`, else `http://127.0.0.1:$SOVA_PORT`, else port 4800. `run --host <peer>` runs a command on another computer through this one.

## Your own program

- Change: nothing. Call Sova's requests from any language.
- Lives: this computer's Sova, at `$SOVA_URL`, else `http://127.0.0.1:$SOVA_PORT`, else port 4800. Never assume 4800 in a chat: this Sova may be on another port. If neither is set and the answer doesn't look like this Sova, ask the person which port it runs on. The token sits in `<agent dir>/sova/auth-token`, and `sova token` prints it. Send it as the `x-sova-token` header: `Authorization: Bearer` doesn't count.
- Approves: holding the token is acting as the person, except for what passes only on the person's click.
- By: Terminal.
- Live: now.
- Check: `GET /api/health` answers without a token, and `GET /api/commands` lists the named commands. Only named commands are a stable surface, so prefer them.

A complete example, which prints every chat's title:

```js
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent");
const token = readFileSync(join(agentDir, "sova/auth-token"), "utf8").trim();
const url = process.env.SOVA_URL ?? `http://127.0.0.1:${process.env.SOVA_PORT ?? 4800}`;
const res = await fetch(`${url}/api/sessions`, { headers: { "x-sova-token": token } });
for (const session of await res.json()) console.log(session.title);
```

## Follow what happens

- Change: nothing. Get an event when a chat starts, ends a reply, is renamed, tagged or archived, or when attention changes.
- Lives: the socket `/ws/events`, or `watch` in the named commands' script. It prints one line of JSON per event.
- Approves: nobody. It only reads.
- By: Terminal.
- Live: now, while the listener stays connected. It's read-only and this computer only, and Sova keeps the last 1,000 events.
- Check: run the listener, send a message in a chat, and see `turn.started` and `turn.ended`.

```sh
node "$SOVA/scripts/sova.mjs" watch
```

Each line carries a `cursor`; pass it back with `--since <cursor>` to resume.

## Speak into a chat

- Change: nothing. A program sends a message, starts a chat, or raises a card that asks the person something.
- Lives: the commands `session.send`, `session.create` and `session.card.post`, and `chat.stop`, `chat.compact` and the other `chat.*` actions.
- Approves: nobody. A chat open in a terminal refuses them, and a `chat.*` action runs at most once.
- By: Terminal.
- Live: now.
- Check: the message or card appears in the chat.

## A project mode's commands

- Change: nothing here. A project mode can declare programs that run by name, with no model involved: see `modes`.
- Lives: `commands` in the mode's `MODE.md`, run as `mode.<id>.<name>` with `--session <chat>`.
- Approves: the person, when they turn the mode on.
- By: Terminal.
- Live: only while the mode is on in that chat, with its sandbox not On and its folder unchanged.
- Check: `list --session <chat>` shows it.

## Who ran what

- Change: nothing. Read who ran which command, whether a script, a chat or an extension.
- Lives: the command `audit.list`. Its rows name routes, never their parameters.
- Approves: nobody. It only reads.
- By: Terminal.
- Live: now.
- Check: run a command, then find it with `audit.list`.

## Rehearse a script

- Change: nothing. Try a script against a throwaway Sova with no credentials and a stand-in model.
- Lives: `<sova folder>/scripts/sova-scenario.mjs`, reading a scenario JSON file of the person's own.
- Approves: nobody.
- By: Terminal.
- Live: per run.
- Check: it exits 0 when every step passed.
