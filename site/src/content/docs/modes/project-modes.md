---
title: Project modes
description: A project can ship minor modes of its own, with instructions, reference files, its own command-line tools, commands you and scripts run, and hooks that run after a reply, offered in every chat started in that project's checkout.
group: Modes
subgroup: Minor
order: 9
---

## What a project mode is

A project mode is a minor mode that lives in a project's own files instead of in Sova. It can hold:

- **instructions**, which the agent gets while the mode is on;
- **reference files** the instructions point at;
- **command-line tools** of the project's own, which the agent can call while the mode is on;
- **commands**, programs of the mode that you, a script or the chat's agent run by name while the
  mode is on;
- **hooks**, programs of the mode that run after a reply starts or finishes in a chat that has the
  mode on.

Every chat working in that project's checkout lists the project's modes in its mode menu, under
**This project · {name}**, read from the files each time you open the menu. A menu that is already
open doesn't follow a change to the files until you open it again. Only those files configure a
mode: Sova's settings, `mode.json`, profiles and automations never name one, and Settings shows
none.

A project mode **never turns itself on**. It is on only when someone turned it on in that chat: you,
from its mode menu or `/mode`, or [the Overseer](/docs/overseer/). A mode file has no way to say
"on by default". Save as default never saves a project mode, and neither a profile, an automation,
a project's coding session nor `pi --minor` can turn one on.

## Where Sova looks

Each mode is a folder in `.sova/minor-modes/` at the top of the checkout the chat runs in:

```
my-app/
  .sova/
    minor-modes/
      release-check/
        MODE.md
        checklist.md
        status.sh
```

The checkout is the nearest folder at or above the chat's folder that holds `.git`, or the chat's
folder itself when none does. This is **not** the main checkout that profiles and playbooks read: a
chat in a worktree sees the modes on its own branch, so you can change a mode on a branch and try it
there before it reaches anyone else. A chat on a remote machine has no project modes, and neither
does the Overseer's own chat.

The folder's name is the mode's id: lowercase letters, digits and hyphens, starting with a letter,
at most 30 characters. It can't be the name of a built-in minor mode (`align`, `spec`, `vis`,
`codemode`, `memory`); a folder with one of those names is listed as broken and never replaces the
built-in.

## The mode file

`MODE.md` is the mode. It starts with a frontmatter block between two `---` lines, then the
instructions:

```markdown
---
description: Check a release is ready before tagging it
workers: no
---

Before you tag a release, read checklist.md and go through it item by item.
```

The frontmatter is `key: value` lines, not YAML, and only five keys are allowed:

| Key | Value |
|---|---|
| `description` | Required. One line, shown under the mode's name in the menu. |
| `workers` | `yes` or `no` (the default). With `yes`, the chat's workers get the mode too. |
| `tools` | A JSON array of tool declarations (below). Lines that start with a space continue it, so it can span several lines. |
| `commands` | A JSON array of command declarations (see [Declaring a command](#declaring-a-command)). |
| `hooks` | A JSON array of hook declarations (see [Declaring a hook](#declaring-a-hook)). |

Any other key is an error, and so is a key given twice or an empty body. There is no key to turn a
mode on by default.

Everything after the frontmatter is the mode's instructions. The agent gets them under a heading,
`# Project minor mode: <id>`, then a `Folder:` line with the mode folder's absolute path. Every
relative path in the mode is relative to that folder, so the instructions can name `checklist.md`
and the agent finds it. Every other file in the folder is yours to use.

## Declaring a tool

A tool is a program in your project that the agent can run. Sova runs it as a separate program and
hands its output back; no project code is loaded into the agent itself.

Each entry in `tools` has:

| Field | Value |
|---|---|
| `name` | Lowercase letters and digits, words joined by single underscores, at most 32 characters. |
| `description` | What the tool does, for the agent. |
| `params` | Optional. A JSON schema for the arguments, with `"type": "object"`. With none, the tool takes no arguments. |
| `command` | The command line, as a JSON array. The first element is either a bare program name looked up on the `PATH` (`node`, `python3`, `bash`), which is the machine's own program and isn't covered by approval, or a `./` path in the mode folder. Every element that contains a `/` must be a `./` path to a file in the mode folder, and Sova passes its absolute path: `scripts/check.js`, an absolute path or `../` is an error. |
| `timeoutS` | Optional. The time limit in seconds, 1 to 600. The default is 60. |

A mode declares at most 16 tools. The agent sees each one as the mode's id, with hyphens turned
into underscores, then two underscores and the tool's name: `release-check`'s `status` tool is
`release_check__status`. So two modes' tools never collide. While the mode is on the agent has its
tools; turning it off takes them away from the agent's next run.

When the agent calls a tool, Sova:

1. runs the command in the chat's folder, with the environment variables `SOVA_MODE_ID`,
   `SOVA_MODE_DIR`, `SOVA_PROJECT_ROOT` and `SOVA_TOOL_NAME` set;
2. writes the call's arguments as JSON to the program's standard input;
3. runs it in a process group of its own, stopped whole if it runs past its time limit or you
   stop the turn;
4. returns its exit code, its standard output and its standard error to the agent, each cut at
   256 KB with the cut marked.

A `./` file that is a symlink leading out of the mode folder, or any argument with a `/` in it that
isn't a `./` path in the folder, is refused when the agent calls the tool, and nothing runs. While the chat's
sandbox is on, project tools don't run at all: the sandbox confines only the
chat's own tools, so the agent is told to ask you to turn the sandbox off.

## Declaring a command

A command is a program of the mode that runs by name, without asking the agent: from a terminal or
a script with `sova run mode.<id>.<name> --session <chat>`, or by the chat's agent from its own
terminal the same way. `sova list --session <chat>` lists the commands of that chat's modes that are
on. Each entry in `commands` has a `name` (the tool-name rule), a `description`, optional `params`
(a JSON schema of an object), `run` (the command line, under exactly the rules of a tool's
`command`) and an optional `timeoutS` (1 to 600, 60 by default). A mode declares at most 16.

A command runs exactly as a tool does: in the chat's folder, with its arguments as JSON on standard
input (`sova run … --args '{"version": "1.4.0"}'`; unlike a tool call's, they aren't checked
against `params`, so the program checks its own), `SOVA_TOOL_NAME` set to the command's name, the
chat's own environment, and its exit code, output and errors in the answer. It runs only while the
mode is on in that chat, from the version the chat turned on, with the chat's sandbox off, while
that version is approved and no file in its folder changed; otherwise it answers with a sentence
saying which. A chat runs at most 4 commands at once. A mesh peer needs the `full` grant to run one.

## Declaring a hook

A hook is a program of the mode that runs after something happened in a chat that has the mode on.
It only reports: it never blocks, delays or changes a reply, and Sova never turns what it prints
into a message. Each entry in `hooks` has `on`, which is `turn.started` (a reply started) or
`turn.ended` (a reply finished, however it ended), `run` (a command line under a tool's rules) and
an optional `timeoutS` (1 to 600, 30 by default). A mode declares at most 8.

A hook gets the event as JSON on standard input, `{"event", "sessionId", "at", "mode"}`, and
`SOVA_MODE_ID`, `SOVA_MODE_DIR`, `SOVA_PROJECT_ROOT` and `SOVA_HOOK_EVENT`. Its environment holds
only the basics (`PATH`, `HOME`, `USER`, the locale, `TERM`, `TMPDIR`) and those four, so a hook
gets no Sova credential in its environment. It is not walled off, though: like any program you run
outside a sandbox, a hook can still read Sova's operator token file from disk under `HOME`.

Hooks run only on replies in a chat Sova hosts, never when a chat opens, reloads or resumes, and
never in a worker or in the plain pi terminal. A hook never runs twice at once: an event while it
runs leaves at most one more run waiting. Each hook runs at most 10 times in any 10 minutes, per
hook, in each chat (a mode's 8 hooks may each run 10 times); past that its runs are skipped, the row says **Hooks paused: a hook ran 10 times in 10 minutes.**,
and it runs again once the 10 minutes allow. A hook that fails or runs past its limit writes one
line to the chat's log and nothing else.

Events of the whole project (a session created or renamed in the checkout) and a chat's attention
aren't offered yet.

## Approving a mode's tools, commands and hooks

A mode with tools, commands or hooks runs programs from the project's files, so it asks before you
turn it on. In the menu its row reads **Asks before turning on: it runs {n} tool(s).** (or what it
runs: "1 tool, 1 command and 1 hook"). Turning it on opens a panel with each tool's, command's and
hook's command line, where it runs from, and which bare programs it starts (`node`, `python3`,
`sh`) are the machine's own and so not covered. **Approve and Turn
On** approves exactly what the panel shows and turns the mode on; **Cancel** changes nothing.
Turning a mode off never asks. If the mode's files change while the panel is open, the approval is
refused and the panel shows the tools as they are now, for you to check again.

Approval covers **everything in the mode's folder**: the tool, command and hook declarations and every file in the
folder, at any depth, hidden files included (a symlink counts as the file it points to), except
`MODE.md` itself. So a script that sources a
helper beside it, or a program that imports a sibling, can't change without asking. Sova asks again
when any of that changes; editing the instructions in `MODE.md` never asks again, and a mode with
no tools, commands or hooks never asks at all. A mode without commands or hooks keeps the approval
it had before they existed. Keep a mode with tools, commands or hooks small: a folder of more than
1000 files or 50 MB can't be turned on. Sova can't tell who wrote a file, so it asks about modes you
or your agent wrote too.

Approvals are kept in Sova's own state, outside every repository. Sova remembers the last 8 approved versions of
each mode in each checkout, so switching back to a branch whose tools you already approved doesn't
ask again. When someone else turns a mode on (the Overseer, a chat's agent, a script or an
extension), their approval covers its tools and commands but never its hooks: they stay inactive,
and the row says **Hooks need your approval.** Its **Approve Hooks** control shows the hooks and
approves that exact version. Only you approve hooks, from Sova's page on this machine: an approval
of hooks from any of those, or through a mesh peer, is refused.

If any file in the folder changes on disk while the mode is on, Sova refuses to run its tools. The agent is told
the mode's files changed, and the row reads **Its tools changed since you approved them, so they won't
run.** Turn the mode off and on to approve the new version.

## What a chat keeps

When you turn a mode on, the chat saves a copy of its `MODE.md` (the description, the `workers`
setting, the instructions and the tools) in its own history, and for a mode with tools a fingerprint
of everything else in its folder. It works from that copy until you turn the mode off, through
reloads, resumes, server restarts and compaction. It never reads `MODE.md` again for it.

So an edit to `MODE.md` doesn't reach a chat that already has the mode on. The row says **Changed
since you turned it on.** Turn the mode off and on to load the changes. The other files in the folder
aren't copied: the agent reads them when it needs them, so an edit to one reaches the chat right
away. In a mode with tools, that edit also marks the mode changed and stops its tools until you
approve it again (see above). If the mode's folder is deleted, the chat keeps its copy, and the row
says **Removed from the project.**, until you turn it off; then the row is gone. If its files turn
broken while it is on, it stays on from its copy too, and the row says **Its files have a problem
now**, with the problem.

The instructions reach the agent the same way a built-in mode's do. A mode that was on when the
chat started, or at its last compaction, is part of the agent's instructions. Turning one on in the
middle of a chat sends its instructions as a hidden note at the next run, after the built-in modes'
instructions, instead of rewriting the instructions the agent already has. A mode with tools also adds or removes them, like align
or codemode, and a change to the agent's tools costs the provider's prompt cache.

## Workers

A mode with `workers: yes` reaches every worker the chat starts while the mode is on, the way
[spec](/docs/modes/spec/) does: the worker gets the chat's copy of the instructions, after spec's,
and the mode's tools if it can run commands. A worker that can't run commands, and a worker on a
remote machine, gets the instructions without the tools. A worker that runs on its worktree's own
agent settings gets neither from the chat. The tools refuse in a worker just as in
the chat: when the mode's files changed since you approved them, or while the worker's sandbox is
on. A worker never reads the mode's folder, and never turns a project mode on itself. A worker gets
at most 8 modes, built-in and project together. A later switch in the chat doesn't reach a running
worker; a resumed worker takes the chat's modes as they are then. Its view in the Subagents pane lists the mode's id on its modes chip.

## From the terminal

`/mode project:release-check on` and `/mode project:release-check off` turn a mode on and off, and
`/mode project:release-check` toggles it. The bare id works too when no built-in mode has that
name. The `/mode` palette lists the project's modes after the built-in ones, and `/mode status`
lists each with its state. `/mode default` never saves one, and `pi --minor` names only built-in
modes. The terminal's status line shows the project modes that are on after the built-in ones.

A mode with tools turns on from the terminal only if you've already approved that exact version of
its tools, in a Sova chat's mode menu. The terminal never asks: otherwise it says to approve the mode
from a Sova chat's mode menu first.

## When a mode is broken

A folder that isn't a usable mode stays in the menu, marked **Can't turn on**, with the problem:

- the folder's name isn't a valid id, or is a built-in mode's name;
- it has no `MODE.md`;
- `MODE.md` doesn't parse: no frontmatter, an unknown key, a key given twice, a bad tool (a path argument that isn't
  `./`, a `./` file that isn't there), a bad command or hook (a hook `on` that isn't `turn.started`
  or `turn.ended`), no instructions;
- a mode with tools, commands or hooks whose folder holds more than 1000 files or 50 MB.

One broken folder never hides the others.

## A worked example

`release-check` reminds the agent of the project's release checklist and gives it one tool: a
status script that reports what is not ready yet. The same script is a command you can run from a
terminal, and a hook writes a line to a log after each reply.

`.sova/minor-modes/release-check/MODE.md`:

```markdown
---
description: Check a release is ready before tagging it
workers: no
tools: [
  {
   "name": "status",
   "description": "Report what is not ready for a release: uncommitted files, missing changelog entry, failing version check. Pass the version to check.",
   "params": {
    "type": "object",
    "properties": { "version": { "type": "string", "description": "The version to release, e.g. 1.4.0" } },
    "required": ["version"]
   },
   "command": ["bash", "./status.sh"],
   "timeoutS": 30
  }
 ]
commands: [{"name": "status", "description": "Report what is not ready", "params": {"type": "object", "properties": {"version": {"type": "string"}}}, "run": ["bash", "./status.sh"]}]
hooks: [{"on": "turn.ended", "run": ["bash", "./log-reply.sh"]}]
---

Before you tag a release, go through checklist.md item by item.

Call release_check__status with the version first. Fix what it reports, call it again, and tag
only when it reports nothing. Never tag without asking the user.
```

`.sova/minor-modes/release-check/checklist.md`:

```markdown
1. CHANGELOG.md has an entry for the version.
2. package.json's version matches it.
3. The working tree is clean.
```

`.sova/minor-modes/release-check/status.sh`:

```bash
#!/usr/bin/env bash
# Arguments arrive as JSON on standard input; the folder is the chat's folder.
version=$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))')
problems=0
if [ -n "$(git status --porcelain)" ]; then echo "The working tree has uncommitted changes."; problems=1; fi
grep -q "## $version" CHANGELOG.md || { echo "CHANGELOG.md has no entry for $version."; problems=1; }
grep -q "\"version\": \"$version\"" package.json || { echo "package.json's version isn't $version."; problems=1; }
[ $problems = 0 ] && echo "Ready to release $version."
exit $problems
```

`.sova/minor-modes/release-check/log-reply.sh`:

```bash
#!/usr/bin/env bash
# The event arrives as JSON on standard input: {"event", "sessionId", "at", "mode"}.
cat >> .release-replies.log; echo >> .release-replies.log
```

Open a chat in the project, open the mode menu, and turn on **release-check** under **This
project**. Sova shows the `status` tool, the `status` command and the hook with their command lines;
approve them. Then ask the agent to get version 1.4.0 ready. It calls `release_check__status` with
`{"version": "1.4.0"}` and gets back the script's exit code and output. After its reply the hook
appends the event to `.release-replies.log`. From a terminal,
`sova run mode.release-check.status --session <the chat> --args '{"version": "1.4.0"}'` runs the
same script and prints its answer.

Change the instructions in `MODE.md` and nothing is asked again: the chat picks them up the next
time you turn the mode off and on. Change `status.sh`, or even `checklist.md`, and the chat stops
running the tool until you turn the mode off and on and approve it again: approval covers the whole
folder.
