---
title: Scripting Sova
description: Drive Sova from your own program. Run its commands, follow what happens, send to a chat, raise a card, and see who ran what.
group: Extending
order: 25
---

Most of what you can do in Sova has a named command. A script runs those commands on this machine,
and can follow a stream of what happens.

## Which `sova`

The commands are in the command line in Sova's own folder:

```sh
node scripts/sova.mjs list
```

Run it from a Sova checkout, or from the install folder (`~/.local/share/sova` by default).

**The installed `sova` launcher isn't this.** It starts the server. It knows `token`, `app` and `open`,
and anything else, `sova run` included, starts the server with those arguments.

## The token

Every call carries Sova's access token. The command line finds it by itself, the way every script
does: `SOVA_TOKEN` if that's set, otherwise the token file in your agent folder. `sova token` prints
it. The token is as good as you on this machine, so keep it out of repositories and logs.

Only this machine can be reached: any host but `127.0.0.1`, `localhost` or `::1` is refused before a
request goes out. Set the port with `SOVA_PORT`, or the address with `SOVA_URL` or `--url`.

## The commands

| Command | What it does |
|---|---|
| `list [--session <chat>]` | Prints every command, extensions' included, and with `--session` the commands of that chat's project modes that are on |
| `describe <id>` | Prints one command and its parameters as JSON |
| `run <id> [--<param> <value>]…` | Runs one and prints its JSON answer |
| `watch [--events a,b] [--since <cursor>]` | Streams what happens |

`--session` takes a chat's id or path. `--json '<object>'`, or `--json -` for standard input, gives
parameters as JSON. A project mode's command, `run mode.<id>.<name>`, takes its arguments with
`--args '<object>'`.

The exit code says how it went:

| Exit | Means |
|---|---|
| 0 | Done |
| 1 | Failed: no answer, a server error, or an answer that isn't JSON |
| 2 | Refused |
| 3 | Invalid: a usage mistake, or an unknown id or parameter |
| 4 | Busy |
| 5 | Outcome unknown, for an action in a chat |

`run --host <peer>` runs a command on one of your other computers through this one.

In a chat Sova runs, the same commands work from the chat's terminal unless its sandbox is on, which
cuts it off from Sova. A command that only reads takes the chat's own session when you leave out
`--session`; one that changes something always needs it named.

## Follow what happens

```sh
node scripts/sova.mjs watch --events turn.ended
```

`watch` changes nothing. It prints one JSON object per line as things happen: `created`, `removed`,
`renamed`, `tagged`, `archived`, `turn.started` and `turn.ended`, with each session's id and path. Each
line carries a `cursor`. Pass the last one to `--since` to pick up where you left off: you get the events
Sova still keeps, the newest 1,000, and a `gap` line for any it doesn't.

Sova never calls you: there are no webhooks. Your program stays connected, on this machine.

A turn in a chat Sova runs always shows, however short. For a session open in a terminal, marked
`observed`, changes come from comparing two reads of the session list, so a very short one can be missed.

## Send to a chat

```sh
node scripts/sova.mjs run session.send --session <chat> --text "Run the checks again"
```

`session.create` starts a chat. Use `describe` for each command's parameters. A chat open in a terminal
refuses, since Sova never writes to a session a terminal holds.

## Raise a card

`session.card.post` puts a [card](/docs/extending/card-types/) in a chat, so your script can ask a question
and read the answer with `session.card.get`. It takes a type in that chat's set, and it's refused
while an alignment question is open. The card says who raised it: "From a script".

## Who ran what

Sova records each call a script makes.

```sh
node scripts/sova.mjs run audit.list
```

A row says who called and which command, and never the parameters. `--caller` and `--command` narrow it,
and `--limit` takes up to 1,000.

## What no script can do

Each of these lets something act later without asking, so it passes only on your own click in Sova's
page. A script, a chat's terminal, an extension or another computer is refused, and the refusal says where
to click.

| Approval | Where you click |
|---|---|
| A project's run buttons | **Approve Run Buttons** on the project page's Offers list |
| A profile's powers | **Approve** in Settings → Profiles or on the profile picker |
| A schedule | **Approve** in the Playbooks dialog or the Overseer's Approvals & Schedules |
| Turning on a Project Overseer power | The power's switch on the project page's Settings tab |
| Lowering a chat's sandbox | The Sandbox rows in that chat's composer. A `/sandbox` sent as a message is refused too |
| Approving a project tool | **Approve and Turn On** in that chat's mode menu |

Only the widening closes. Turning a power off, raising a sandbox, turning a mode off and turning on a
mode at a version already approved stay open to scripts.

**Apply and Approve** on a Settings change card is your click too, and the same goes for Apply itself,
trusting a project's or an extension's cards, and approving a project mode's hooks.

The Overseer keeps what it could already do: when it turns a project mode on, that still approves the
mode's tools and commands, never its hooks. See [The Overseer](/docs/overseer/#what-it-can-do).

A schedule on another of your computers can be approved from this page, with proof of your click carried
across the link between the computers. Anything else that belongs to another computer is approved on that
computer's own page.

Shipping is yours too: no script plans, runs or rolls back a deploy.

**How strong this is.** It raises the bar; it isn't a wall. Sova tells its page from a program by how the
token is sent. A chat without the sandbox runs as you, so it can read the token from disk, and a program
that imitates the page is taken for it. A chat with its sandbox on can't reach Sova at all. The refusal
stops the ordinary road and gives a chat the words to send you to the page.
