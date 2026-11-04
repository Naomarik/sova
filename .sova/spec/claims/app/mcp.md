# §app/mcp — MCP servers
> Part of the Sova design spec · [overview](../design/overview.md)

Every ordinary Sova chat can use MCP servers, on pi models and on Claude Code models alike. A server
is an address or a command that gives a chat more tools. A person adds one for this computer on
Settings → **MCP Servers**, or a project declares one in its shared `.mcp.json`. Nothing a server
runs starts until the person has approved it on the page (§app.mcp/approval).

Sova alone decides what a chat loads. A chat's servers are the ones this surface describes, and no
other way of loading a server reaches a Sova chat: a repository's own pi server file
(`.pi/mcp.json`) is ignored, and the Claude CLI behind a Claude Code chat loads none of its own. This
is a Sova feature. It asks nothing of a terminal, and the pi TUI and standalone Claude Code are
outside it. Which chats get servers is §app.mcp/who-gets; how the words read is
§design.copy-deck/mcp-servers.

## §app.mcp/settings-tab — The MCP Servers tab

Settings gains **MCP Servers**, the tab after Accounts. It lists this computer's servers, one row
each (§app.mcp/rows), under **Add Server**, and says that each project's own servers are on its
project page. Its list is `mcp.json` in the agent dir, so a server added from a terminal or by a
chat shows here too, as Waiting for You. The tab saves on its own: every action and switch on it
applies at once, and none waits for the dialog's Save Changes.

## §app.mcp/add-server — Add Server

**Add Server** opens a dialog with three ways in: **Address**, **Command** and **Paste from Another
Tool**, which takes an entry in the shape other tools write it. Each has a **Name**, and the
Address and Command forms have a Secret field (§app.mcp/secrets). **Add and Check** saves the entry
to this computer's list, counts as approving that exact entry (§app.mcp/approval) and runs a Check
at once; the dialog shows the result on the new row. The entry only ever names a secret: its value
is saved apart from the list (§app.mcp/secrets). Edit has the same fields.

- **Command.** Beside Secret is **Secret's Name**: the value reaches the server as the environment
  variable of that name. A Secret with no Secret's Name can't be added.
- **Address.** The value is sent to the server as `Authorization: Bearer <value>`.
- **Paste from Another Tool.** The entry may stand alone, sit under `mcpServers` or be keyed by its
  name, and a pasted entry that names one server fills an empty Name. A single server pasted under
  a different Name works, and the Name wins. A paste of several takes the one the Name matches; with
  a Name matching none it is refused and adds nothing. One Sova can't read is refused and adds
  nothing. A pasted entry that says `${NAME}` is taken at its word: the new row asks for
  `NAME`, and the form has no Secret field.
- **Names.** A name already on this computer's list is refused. A Secret's Name is letters, digits
  and underscores.
- **Edit keeps what it doesn't show.** It changes only what its fields name: the entry's other
  values, headers and folder stay as they were, and a saved secret stays saved. Changing an address
  server to a command, or back, makes a new entry instead.

- **`sova` is reserved.** The name `sova`, in any case, is Sova's own. On a Claude Code chat Sova's
  tools already reach the model under it (§app/claude-code-provider), so a server's tools would read
  almost the same as Sova's, and a condensed history's plain text could name the wrong one. Calls
  themselves still reach the right tool: the refusal keeps the names apart, it fixes no wrong call.
  Add Server and Edit refuse it. In a project's file
  or this computer's list an entry with that name never runs and is never offered for approval; its
  row says why.
- **Page only.** Adding and editing count as approving, so they take the same page-only route as
  approving (§app.mcp/approval).

## §app.mcp/check — Check

A **Check** starts the server for a moment, away from any chat, asks for its tools, stops it, and
records what it found: the server's own name, version and instructions if it gives any, each tool's
name, description and parameters, and what their declarations cost in tokens. **That record is what chats list** (§app.mcp/tool-list). A chat never asks a server
for its tools.

- **When.** On Add Server, after an Edit on the page, after approving, on **Check Again**, after
  Sign In and after a secret is saved on an approved row. Never on a timer and never when a chat
  opens.
- **Where.** In a short-lived process of its own, never inside the server's process, with the clean
  environment of §app.mcp/environment. Its rules on values hold for a Check as well, headers and
  sign-in values included.
- **Never before approval.** A Check of a server that is Waiting for You runs nothing.
- **A failed Check** keeps the record the same approved version already had, and the row reads
  Failed with the server's error lines. A changed entry has no record until a Check of the new
  version succeeds.

## §app.mcp/rows — A server's row

Each row names the server, says whether it is an address or a command, and shows one state and its
tool count. The first state that applies is the row's:

| State | Means |
|---|---|
| **Waiting for You** | Not approved. Nothing runs. It shows what it runs and its secrets' names, with **Approve** (§app.mcp/approval). |
| **No Check yet.** | Approved, with no record, and no Check of this version has finished. No chat can list it. It shows **Check Again** on the row. |
| **Off** | Its New Chats switch is off (§app.mcp/tool-list). A chat can still switch it on. |
| **Needs Sign-in** | The last Check found that the server needs a sign-in. |
| **Failed** | The last Check failed. |
| **Connected** | The last Check succeeded. |

A refused entry reads Waiting for You too, but nothing can approve it: it has no Approve and no
Check. That is an entry named `sova` (§app.mcp/add-server) and an unusable entry, one with a bad
`type`, no command or address, a field of the wrong shape, or an `auth` key in a project's file. An
unusable entry's row names the field and says it can't be used (§design.copy-deck/mcp-servers). A
refused entry is on no setup card (§chat.transcript/setup-card-toggles).

A row opens to its tools, each with its own off switch, and to its last error lines, with **Check
Again**, **Sign In** (for a server that signs in), **Edit** and **Remove**. Error lines come from the
last Check and from a chat's copy that failed (§app.mcp/in-a-chat), which names the chat; a filled
value is masked in them (§app.mcp/secrets).

- **Per-tool switches** go by tool name, are kept when an entry changes and apply to new chats. A
  tool a Check finds for the first time is on.
- **Sign In shows** on an address server with no Authorization header of its own, whose last Check
  of this version found it needs a sign-in or which already has a sign-in kept. So an unchecked
  address row shows no Sign In.
- **Moving an address.** A page Edit that moves an address deletes the old address's sign-in. A move
  made by hand in the file doesn't go through Edit, so its old sign-in stays, after Remove too. Where
  an address has a `${NAME}` in it, that row's sign-in isn't found or forgotten.
- **Edit** saves on the page and counts as approving the new entry. **Remove** deletes the entry
  from this computer's list with its approval, record, secrets and sign-in. Chats that already list
  it get a failed call and the note of §app.mcp/in-a-chat.
- A project server's row has no Edit or Remove: changes go through the file
  (§app.mcp/project-servers).
- A computer server replaced in a folder keeps its row, which says where it is replaced
  (§app.mcp/project-servers).

## §app.mcp/sign-in — Sign In

**Sign In** opens a dialog and the service's sign-in page in a new tab. Sign-in finishes on the
computer running Sova. From anywhere else, a phone or another computer, the sign-in page ends on an
address that won't load, and the person pastes that address into the dialog to finish. Only the
page can sign in (§app.mcp/approval's refusals), and only for an approved server. The sign-in is
saved on this computer outside every repository, is never shown and never copies to another
computer. A Check follows. A sign-in that expires reads Needs Sign-in at the next Check. A call that
hits a sign-in failure fails with "it needs a sign-in", and the chat gets the note of
§app.mcp/in-a-chat.

A sign-in stays with its address. A server moved and re-approved mid-chat gets no token at the new
address, in a Check or in a chat's new copy; a copy already running is §app.mcp/approval's.

## §app.mcp/project-servers — A project's servers

A project declares servers in the shared `.mcp.json` at the root of a checkout, in the same shape
other tools read, so a project that already has one for Claude Code shows up ready to approve.

- **On the project page.** The project page's Settings tab has an **MCP Servers** section beside
  Offers (§chat.offers/project-list), with the same rows, grouped by checkout. No file says how to
  add one, and a broken file says why and gives no servers.
- **Changes go through the file.** The section adds, edits and removes nothing. Its rows carry
  Approve, Check Again, Sign In, the switches and the Secret fields.
- **A chat reads the copy in its own folder.** A chat in a worktree reads that worktree's
  `.mcp.json`, so a worktree's copy is approved separately, even when it matches the main
  checkout's byte for byte.
- **The same name in both.** When a project's server has the same name as a computer server, a chat
  in that project's checkout uses the project's, and the computer's stays out of that chat, even
  while the project's is Waiting for You or Failed. Both rows stay visible: the project's on the
  project page and the computer's in Settings, which says it is replaced there. Elsewhere the
  computer's server works as before.
- **A folder that is no project** has no page to approve on, so its `.mcp.json` runs nothing, and
  the setup card says so.

## §app.mcp/approval — Approving a server

Every server not added on the page waits as **Waiting for You** until the person approves that exact
version on the page. That covers every entry in a project's `.mcp.json` and every entry in this
computer's list that the page didn't write (from a terminal, a chat or a hand edit): Sova can't tell
who wrote a file. Adding or editing on the page counts as approving, so normal use has no extra step.

- **What you see.** The row shows what the server runs (its command and arguments, or its address),
  the names of its environment values and secrets, and "Runs the newest version each start" for a
  package with no pinned version. **Approve** approves what it shows.
- **What it covers.** The exact entry, and the files in the folder of any `./` path the entry
  names. That skips `.git`, `node_modules`, `.worktrees` and `.agent`; a file over 4 MB counts by its
  size and time, not its bytes; and past 20,000 files in a folder the rest go uncounted. Any change
  to what is counted asks again. A version approved before stays approved, the newest 8 for each
  server.
- **Where `./` starts.** A project entry's `./` paths resolve from its checkout and a computer
  entry's from the agent dir, for its version and for its start, so a repository can't swap the
  file behind an approval.
- **Where it is kept.** `<state root>/mcp-trust.json`, per computer and per checkout, outside every
  repository, and it never copies to another computer. No branch or clone carries an approval.
- **What you approve is what you saw.** The request carries the version the page showed and is
  refused when the entry has changed since.
- **Only the page approves.** A chat, script, extension, Overseer or another computer is refused, and so
  is a call that doesn't show itself as the page by the install's cookie on the main listener, as at
  every approval of §app.access/your-click. A
  project overseer's Settings change card never approves a server. Approving is a trust grant: it is
  no catalogue command (the commands inventory classes it so) and no agent tool reaches it.
- **Nothing runs before approval.** No Check, no sign-in, no copy in a chat. Every start checks the
  approval again, so a chat that lists a server whose entry has since changed starts nothing and
  gets the note of §app.mcp/in-a-chat. Only a start checks: an entry edited mid-chat, re-approved
  or not, keeps its running copy, at its old address too, until that copy stops. A page Edit that
  moves an address deletes the old sign-in (§app.mcp/rows), so that copy's next call fails with "it
  needs a sign-in".
- **The limit.** Telling the page from a program holding the token is a heuristic, and a chat with a
  shell and no sandbox runs as you (§chat.profiles/enforcement). These are guardrails: the sandbox
  is what contains a chat.

## §app.mcp/secrets — Secrets

A server that needs a key gets it from a **Secret** field in Settings or on the project page. The
value is saved on this computer outside every repository (`<state root>/secrets/mcp/`, a folder only
the owner can read), is never shown again and never copies to another computer. After saving, the
field says only that a secret is saved, and it can be replaced or removed. No row or read carries
a value, and a saved value is left out of what the Overseer reads.

For each launch Sova replaces the values it filled, saved and environment-resolved alike, with
`[secret]` in error lines, status errors, JSON-RPC error replies, notifications and unreadable-line
errors. In a chat, an address server's copy also masks each header as written, the credential after
a header's scheme and its client secret, filled or not. A header value or client secret under 4
characters is masked only if it was filled from a secret. A secret written into an address as plain
text isn't scrubbed, only one named there as a value. Sova replaces exact text, so a short value such
as `8080` is masked wherever that text appears, and an encoded value isn't caught. What a tool answers
and an error the tool returns (an `isError: true` result) are both the server's own and reach the chat
and the model as they come, so a server that repeats a key in either sends it to them.

A project file may name a secret, and never holds one: an entry's value says `${NAME}`, and the
row asks for that name. A pasted entry names one the same way (§app.mcp/add-server). A secret belongs to the row it was saved on, a computer server or a project's
server, so a repository can't reach another's by naming it. Every checkout of a project shares that
project's saved secrets. A named secret with nothing saved leaves the server unable to start, and
its row says which one. Saving a secret on an approved row runs a Check (§app.mcp/check). In a computer entry a name set in Sova's environment needs nothing saved,
so its row doesn't ask (§app.mcp/environment).

## §app.mcp/environment — What a server is given

Each server gets a clean environment: the basics a program needs (the path, home folder, user name,
locale, time zone and temporary folder) plus only what its entry names. Sova's own keys, pi's
variables and the provider keys in Sova's environment never reach it unasked.

**Under the sandbox** a command server gets that same clean environment, narrower than what the
chat's own commands see, plus what the sandbox sets for anything it confines: its own temporary
folder, its proxy variables (both spellings of `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and `NO_PROXY`,
and `NODE_USE_ENV_PROXY`) and `GIT_CONFIG_SYSTEM` (§chat.sandbox/git-cleanup). They hold no secret:
they name a local proxy port and the sandbox's own files. Under write-only confinement, which has no
proxy, the temporary folder and `GIT_CONFIG_SYSTEM` are what it adds.
A shell or mise shim on the way to the command adds its own bookkeeping (`PWD`, `SHLVL`,
`__MISE_SHIM`).

Nothing in a value runs, in a computer entry or a project's file: `!command` is a literal string, so
a pasted entry that uses one passes that text on. `${NAME}` is the one form a value can use:

- In a computer entry it names a saved secret, else an environment variable of that name.
- In a project's file it names only a saved secret, never one of Sova's variables or any other
  environment variable: `${HOME}` there asks for a secret called HOME.
- Any other form, such as `${a b}`, makes the entry refuse to start, and its row says which.

## §app.mcp/this-computer — Servers stay on their computer

A computer's servers, approvals, secrets and sign-ins never copy to another computer, with the mesh
on or off (§mesh/sync). A chat running on another computer uses that computer's servers: its setup
card lists them, its failures name that computer, and approving or signing in happens on that
computer's own page, since a page reached through another host is refused.

## §app.mcp/tool-list — What a chat lists

Every tool of a server that is on is always listed to the model, from the server's Check record,
with no search step. The per-tool off switches and the setup card are how a list gets shorter.

- **New Chats.** Each row has a **New Chats** switch, on by default. A server starts on in every new
  chat while it's on and off while it's not. Either way the setup card switches it for that chat
  (§chat.transcript/setup-card-toggles).
- **Token cost.** The setup card shows each server's cost as measured at its last Check, for its
  tools that are on.
- **Fixed when the chat starts.** A chat's tool list is settled when its first message is sent and
  stays as it is for that chat's life: across a reopen, a code reload and a server restart, whatever
  happens to the server's record. The chat keeps its own copy in its session state, so a fork keeps
  its parent's. Tools a server gains later reach new chats. So a server's tools never change a
  running Claude Code chat's tool set (§app.claude-code-provider/continuity).
- **Which servers.** A chat's list holds the approved servers that have a Check record: this
  computer's and those of its folder's checkout, the project's where both have the same name
  (§app.mcp/project-servers). A chat that began before this feature has none.

## §app.mcp/in-a-chat — A server in a chat

Each chat runs its own copy of a server, started at the first call to one of its tools and stopped
with the chat. An address server's copy is one session with it, held across turns. A chat that never
calls a server runs nothing for it. On a pi model and a Claude Code
model it works the same: on Claude Code the tools reach the model as every other tool does
(§app/claude-code-provider).

- **Tool rows.** A call appears as a tool row naming the server and the tool, from its first frame
  to after a reload, a tab that rejoins mid-call and a tool whose long name was shortened included.
  While it runs, the chat's status line names them the same way. Only a name the chat's kept list or
  the call's result says is a server's tool reads so.
- **No asking.** A chat doesn't ask before a tool runs. The per-tool off switches are the control.
- **When a server fails.** The call fails with the reason, so the model reads it as any failed
  tool, and the chat shows a note naming the server that links to its row in Settings, or on the
  project page for a project server. The chat carries on, and its other tools are unaffected.
  The note and the row's line come once, until the server next runs.
  In a chat on another computer the page draws the note instead, since a server only sees its own
  computer's chats: it names that computer and doesn't link.
- **A failed request.** On an address server it ends the session, as an exit ends a command
  server's process: the calls waiting on it fail, the chat gets the note and the row a line, and
  the next call opens a fresh session.
- **A lost session.** A 404 for a session the server has dropped reopens one and sends the call
  again, so nothing fails.
- **A copy that stops.** A call arriving while a copy stops waits for the next copy. A call already
  in flight on that copy waits for its timeout.
- **A removed server.** A server removed mid-chat gives a failed call and the note, and a copy
  still running ends at that call.

## §app.mcp/who-gets — Which chats get servers

- **Ordinary chats** get servers as above: every chat the setup card's switch window calls ordinary.
- **Workers and team members** get only the servers the chat names when it starts them, through a
  list of server names on `agent_spawn`, `team_create` and `team_add`. It is capped to the chat's own
  list with its tools as trimmed there: a name the chat doesn't have is refused at the start with
  the names it does. With none named, a worker has none. A worker runs its own copy, and a worker's
  list is fixed at its start and kept when it resumes. A worker on `useWorktreeConfig` that names
  servers is refused at the start: its agent dir is its worktree's, where the chat's servers,
  approvals and secrets aren't.
- **Profiles.** A profile can remove the **MCP Servers** capability, and a chat on it has no servers
  (§chat.profiles/model). That leaves Workers & teams as they were (§chat.profiles/enforcement).
- **None at all:** the Overseer, project overseers, batons, gathering chats, the Project Assistant,
  the merge thread and the merge reviewer, whatever their settings say. Hidden chats
  (§app.chat-processes/workers) get none either.

## §app.mcp/sandbox — Sandboxed and remote chats

- **Sandbox Off or Subagents only.** A chat's servers run as this surface says, outside any sandbox,
  except in a worker under write-only confinement (below).
- **Write-only confinement.** A command server named for a worker under write-only confinement
  (§chat.worktrees/workers) runs under that same confinement, with the environment of
  §app.mcp/environment.
  If that stops it, its row's error lines and the chat that started the worker both say so.
  Address servers stay off for that worker: a call to one fails with the same reason as under
  Sandbox On. The worker sees the failure in its own tool result, and no note reaches the chat that
  started it.
- **Sandbox On, command servers.** A command server runs inside the chat's sandbox, under its
  filesystem and network limits, its tracked worktrees included, with the environment of
  §app.mcp/environment: the basics and its entry, and the sandbox's proxy variables and
  `GIT_CONFIG_SYSTEM` still reach it. One that
  needs what the sandbox blocks may fail: its row's error lines and the chat's note both say it
  failed inside the sandbox. If the sandbox can't run, the server doesn't start; it never runs
  unconfined instead.
- **Sandbox On, address servers.** They stay off: a chat started On doesn't list them, and its setup
  card says why.
- **Changing the sandbox mid-chat.** The chat's tool list stays as it is, as the sandbox promises
  (§chat.sandbox/states). A change to or from On stops the chat's running copies, and the next call
  starts one under the new state. A listed address server's call fails while the chat is On, with
  the reason and the note.
- **Remote chats.** A chat whose tools run on a remote target gets no servers, because a server
  would run here while the chat's files are there. Its setup card says so when this computer has a
  server.

## §app.mcp/reads — What scripts and agents can read

Scripts and agents can read the server list and each server's status through the commands catalogue:
`mcp.servers.list` and `mcp.server.status` (§app.commands/catalogue). They give each server's name,
where it comes from, whether it is an address or a command, its state, tool count, tool names and
last Check, and never a secret's value. Everything that changes a server stays on the page: approving
and signing in are refused to every other caller (§app.mcp/approval), and no catalogue entry adds,
edits or removes one.
