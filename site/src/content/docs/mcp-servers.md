---
title: MCP servers
description: An MCP server gives your chats more tools. Add one in Settings or declare one in a project, and every ordinary Sova chat can use it, on pi models and Claude Code models alike.
group: Features
order: 17
---

## What a server gives a chat

An MCP server is an address or a command that gives a chat more tools: search your docs, read an
issue tracker, query a database. Once a server is on, the model sees its tools the same way it sees
every other tool, whichever model the chat runs.

Chats don't ask before a tool runs. If you don't want a tool used, switch it off (see
[Trim what a chat lists](#trim-what-a-chat-lists)).

Sova alone decides what a chat loads. A repository's `.pi/mcp.json` is ignored, and the Claude CLI
behind a Claude Code chat loads no servers of its own.

## Add a server

Open **Settings → MCP Servers** and press **Add Server**. There are 3 ways in:

- **Address**: the server's URL. If it needs a key, put it in **Secret**, and Sova sends it as a
  bearer token.
- **Command**: the line that starts the server, such as `npx -y some-server`. If it needs a key, put
  the environment variable in **Secret's Name** and the value in **Secret**.
- **Paste from Another Tool**: an entry in the shape other tools write it. A name in the entry fills
  the **Name** field.

Each one needs a **Name**. The name `sova` is Sova's own, in any case, so it's refused.

**Add and Check** saves the server, approves it and runs a Check, and the dialog shows the result.
A Check starts the server for a moment, asks for its tools, and stops it. What it finds is what your
chats list. Sova never checks on a timer or when a chat opens, so a server's new tools arrive after
you press **Check Again**, and only in new chats.

Address servers can be added, checked and signed in to, but they don't run in chats yet. Command
servers do.

## What a row says

Each server has one row, with its name, whether it's an address or a command, its tool count, and
the first state that applies:

| State | Means |
|---|---|
| **Waiting for You** | It isn't approved, so it runs nothing. |
| **Off** | Its **New Chats** switch is off. A chat can still switch it on. |
| **Needs Sign-in** | The last Check found that it needs a sign-in. |
| **Failed** | The last Check failed. Its error lines are on the row. |
| **Connected** | The last Check succeeded. |
| **No Check yet** | It's approved, but a Check hasn't finished. |

Open a row to see its tools and last error lines, with **Check Again**, **Sign In**, **Edit** and
**Remove**. An error line from a chat's copy of the server names that chat.

**Remove** takes the server's approval, secrets and sign-in with it. A chat that already lists the
server gets a failed call and a note.

## Sign in

**Sign In** opens the service's sign-in page in a new tab. On the computer running Sova, that's all
it takes. From a phone or another computer, the page ends on an address that won't load: copy that
address, paste it into the dialog, and press **Finish Sign-In**.

Your sign-in is saved on the computer running Sova, outside every repository, and is never shown.

## Why a server waits for you

A server runs programs on your computer, so nothing runs until you approve it on the page. A server
you add on the page counts as approved. Every other one waits as **Waiting for You**: every entry in
a project's `.mcp.json`, and every entry in this computer's list that the page didn't write, such as
one added from a terminal or by a chat. Sova can't tell who wrote a file.

Open the row to see what it runs, the names of its values and secrets, and whether it runs the newest
version each start. **Approve** approves exactly that. Any change asks again, including a change to a
file in the folder of a `./` path the entry names.

Only you can approve a server or sign in to one, on the page. A chat, a script, the Overseer and
another computer are all refused. In a chat with a shell and no sandbox, that's a guardrail, not a
wall: the sandbox is what contains a chat.

## Secrets

A key goes in a Secret field, in Settings or on the project page. It's saved on this computer outside
every repository, is never shown again, and never copies to another computer. After saving, the field
says only that it's saved, and you can replace or remove it.

A project's file can name a secret but never holds one: a value says `${NAME}`, and the row asks for
`NAME`. Until it's saved, the server can't start and its row says which one is missing. A secret
belongs to the row it was saved on, so a repository can't reach another project's by naming it.

Each server gets a clean environment: the basics a program needs, plus what its entry names. Sova's
own keys and your provider keys never reach it. In a project's file, a command inside a value doesn't
run, and a value can only name a saved secret.

## A project's servers

A project declares servers in `.mcp.json` at the root of a checkout, in the same shape other tools
read, so a project that already has one for Claude Code shows up ready to approve.

They appear on the project page's Settings tab, in **MCP Servers**, grouped by checkout. Changes go
through the file, so that section adds, edits and removes nothing. Its rows carry **Approve**,
**Check Again**, **Sign In**, the switches and the Secret fields.

- **Each worktree approves its own copy.** A chat reads the `.mcp.json` in its own folder, so a
  [worktree](/docs/worktrees-and-changes/)'s copy needs its own approval, even when it matches the
  main checkout's exactly.
- **The project's server wins a name clash.** In that project's checkouts a chat uses the project's
  server, and your computer's stays out of the chat, even while the project's is waiting or failed.
  Your computer's row says where it's replaced.
- **A folder that isn't a project** has no page to approve on, so its `.mcp.json` runs nothing.

## Trim what a chat lists

Every tool of a server that's on is listed to the model on every turn, and that costs tokens. Three
switches make the list shorter:

- **Each tool** has its own off switch on the row. It applies to new chats.
- **New Chats** on a row decides whether a server starts on in new chats.
- **The setup card** of a new chat, under **System context**, lists each server with its token cost
  from its last Check, and a switch for that chat alone.

A chat's list is settled when you send its first message and stays as it is for that chat's life,
through reloads and restarts. Tools a server gains later reach new chats.

Each chat runs its own copy of a server, started the first time it calls one of its tools and stopped
with the chat. A chat that never calls a server runs nothing for it.

When a server fails in a chat, the call fails with the reason, the chat shows a note with **Open Its
Settings**, and the chat carries on.

## Workers and profiles

A worker or team member gets only the servers its chat names when it starts them, from the chat's own
list. With none named, it has none. It runs its own copy.

A session profile can remove the **MCP Servers** capability, and a chat on it has no servers.

The Overseer, project overseers, batons, gathering chats, the Project Assistant, the merge thread and
its reviewer never get servers, whatever their settings say.

## Sandboxed and remote chats

- **Sandbox Off or Subagents only:** servers run outside any sandbox.
- **Sandbox On:** a command server runs inside the chat's sandbox, under its limits. One that needs
  what the sandbox blocks may fail, and the note says so. If the sandbox can't run, the server doesn't
  start; it never runs unconfined instead. Address servers stay off.
- **Write-only workers:** a command server named for one runs under that same confinement.
- **Changing the sandbox mid-chat:** the chat's list stays as it is. A change to or from On stops the
  running copies, and the next call starts one under the new state.
- **Remote chats:** a chat whose tools run on a remote target gets no servers, because a server would
  run here while the chat's files are there. Its setup card says so.

## Servers stay on their computer

A computer's servers, approvals, secrets and sign-ins never copy to another computer, with the mesh
on or off. A chat running on another computer uses that computer's servers, and you approve and sign
in on that computer's own page.

Scripts and agents can read the server list and each server's status, and never a secret's value.
Everything that changes a server stays on the page.
