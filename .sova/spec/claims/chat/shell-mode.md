# §chat/shell-mode — Shell mode: running a command from the message box

> Part of the Sova design spec · [overview](../design/overview.md)

Typing `!` into a chat's empty message box turns it into a shell box: what you write there runs as
a shell command in the chat's folder, and the command and its output show as a card in the chat
instead of going to the model as a message. The model gets the command and a cut of its output
with your next message and doesn't reply to them on its own; `!!` runs a command the model never
sees. These are pi's own `!` and `!!`, which Sova runs from the message box and nowhere else.

Owns: entering and leaving shell mode and how the box looks in it, where and how a command runs
(its folder, its sandbox, the kill guard, several at once, stopping it, its size limit), the
command's cards and its full output, what the model gets, what a running command does to its chat,
and who can start or stop one. Not here: the composer it lives in (§chat/composer), the transcript
that holds the card (§chat.transcript/transcript-items), what the sandbox confines (§chat/sandbox),
what the kill guard refuses (§chat/kill-guard), and the priority commands run at
(§app.load-priority/workers).

## §chat.shell-mode/box — Entering and leaving shell mode

In the message box of every chat with its own agent and folder (an ordinary chat, a Claude Code
chat, a worker's, a team member's and a coordinator's), typing `!` into the empty box switches it
to shell mode, and so does a `!` typed outside a text field that lands in the empty box
(§chat.composer/type-anywhere).

- **The look.** The `!` you typed becomes a marker at the box's left, beside the text, so the
  command you write stays clean. The box's edge takes the caution tone (`--status-warn`), the
  placeholder reads `Run a command in {folder}…` ({folder} the last part of the chat's folder,
  "this chat's folder" before it is known), followed by `Enter runs` exactly when Enter runs (the
  message box's key-hint rule, §chat.composer/behavior), Send reads `Run`, and the foot shows a
  `Shell mode` chip with the terminal icon, after the model indicator and the Claude login, before
  the disabled reason and the mode switch. The mode never rests on colour alone: the marker and the
  chip's icon and words say it too, and it adds no accent (§design/ground-rules). With focus, the
  caution edge carries the focus ring itself, one ring: the focus width in the caution tone, right
  against the edge.
- **For a screen reader.** In shell mode the textarea's label is `Shell command`. Entering and
  leaving are said in the page's polite live region: "Shell mode on.", "Shell mode on, not shared
  with the model." for `!!`, "Shell mode off.". A reason under the box is said there too, and leaves
  the live region when it leaves the box.
- **`!!`.** Typing another `!` into the empty box while it is in shell mode makes the marker `!!`:
  that command and its output never reach the model (§chat.shell-mode/model). Its placeholder reads
  `Run a command in {folder}, not shared with the model…`. A third `!` is the command's own.
- **Leaving.** Backspace or `Esc` in the empty box leaves shell mode for a message box. From `!!`,
  Backspace goes back to `!` and `Esc` to a message box. `Esc` in shell mode never stops a reply
  (§chat.composer/esc-stop): leaving takes it in the empty box, and with a command typed it does
  nothing, so the reply keeps running. After a command runs, the box is a message
  box again.
- **Pasting.** Pasting text that starts with `!` into the empty box enters shell mode as typing it
  would: the leading `!` (or `!!`, private) becomes the marker and the rest is the command.
- **Keys.** The message box's own (§chat.composer/behavior): `Enter` runs, except in touch mode,
  where it adds a line and `Run` runs; `Ctrl+Enter` / `⌘+Enter` always runs; `Shift+Enter` adds a
  line. An empty or whitespace-only command doesn't run.
- **Menus.** In shell mode the `/` menu (§chat/slash-commands) and the `@` menu stay closed.
- **A command carries nothing else.** Pending images and answers staged on a card stay where they
  are and wait for your next message.
- **While the model replies** the box enters shell mode as ever, its button still reads `Run`, and
  the command runs at once (§chat.shell-mode/running). The box's own Stop stops only the reply.
- **Running it.** Run keeps the command in the box until the chat answers. Once it starts, the box
  is a message box again ("Command started. Shell mode off." is said), unless the command was
  changed meanwhile. A command Sova refuses (the kill guard, a sandbox that can't be prepared)
  stays in the box with the reason under it, in the composer's reason line, on a line of its own
  under the foot's controls (which keep their size), what it quotes in backticks drawn as code; it
  never ran, isn't saved and never reaches the model. A Run while the chat is still connecting
  sends nothing, then or later, and the box says "Not connected yet. Run it again once the chat
  connects." until it has. With no open connection nothing is sent and the box says "Not
  connected. Run it again once the chat reconnects."; in a chat closed for being quiet, that Run
  also starts the chat. When the connection drops before the chat answers, the reconnect answers
  instead: the box empties if the command started, else it says "The connection dropped before the
  chat answered. Check the chat before you run it again." Whether a chat has shell mode is the
  chat's own word, in its first message to the page.
- **A message coming back.** A message handed back to the box (Stop's queued message) or staged in
  it (a card's text for your next message) while it is in shell mode turns it into a message box,
  and a command already typed stays in it as plain text with its leading `!` or `!!` in view.
- **Drafts.** A draft written in shell mode is kept with its mode, `!` or `!!`, saved apart from its
  text (§chat.composer/behavior, "Drafts"), so a reload, a switch back or another device opens the
  box in shell mode with the command in it. A leading `!` in a draft's text is only ever text: a
  message that starts with `!` reopens as that message. Only your own page on this computer saves a
  draft's mode. A draft saved in shell mode from another computer's page (over the peer listener),
  by a script or by a chat is stored as a plain message with its `!` or `!!` kept in front of the
  text, so it reopens in view as `!ls` or `!!…` and `Enter` sends exactly what you see. A draft set
  any other way (a message Stop hands back, a card's text staged for your next message,
  `session.draft.set`, an orphaned dialog's text) opens as a plain message, its `!` or `!!` in view. Before the chat's first message to the page, the box offers shell mode unless the
  page already knows the chat has none, so a `!` or `!!` typed into the empty box enters shell mode
  as ever and a command saved in shell mode shows its marker; `Enter` there is a Run, never a
  message: it sends nothing and the box says "Not connected yet. Run it again once the chat
  connects." Once the chat offers shell mode, Run runs it as a command; once the chat says it has no shell mode, a command in the box
  turns into its visible text (`!ls`) at once, so `Enter` sends what you see, as a message; the saved
  draft keeps its mode until the box is written to.
- **Where there is no shell mode.** A session open in a terminal stays read only. The Overseer,
  project overseers, project assistants and gathering sessions have none, because their agents have
  no shell, and a workspace's group composer has none either (§workspace.groups/the-group-composer).
  In each of them a leading `!` is text, sent as written, as is a `!` in a `/btw` side question.
  Each composer has shell mode only where its chat gives it, so a new composer never gets it by
  accident.

## §chat.shell-mode/running — Where and how a command runs

- **Where.** In the chat's folder, with the environment the agent's own commands get, at the same
  lowered priority (§app.load-priority/workers). When your login shell is zsh (the one Sova was
  started with, else your account's own), a `!` command runs in zsh with your own terminal setup
  loaded first: your login profile, then your shell config, from your zsh config folder when you
  set one (`ZDOTDIR`), else your home folder, never the computer's shared ones. So your aliases,
  functions and variables work. The setup's own messages are hidden, and a setup that fails partway
  still runs the command, with what loaded before the failure. The setup loads after you press Run,
  for every command: each one is a fresh shell, so an edit to your config applies to your next
  command. It loads the same with the sandbox On or Off; with it On it loads confined like the
  command: it can read your config but can't write outside what the sandbox allows, and its failed
  writes stay hidden. A command follows zsh's rules, not bash's: an unmatched glob is an error, and
  an unquoted variable doesn't split into words. Shell mode doesn't act as a terminal, so a config
  that stops early when not run in one loads only up to that point. The agent's own commands keep
  the shell they always had. With another login shell, or when pi's `shellPath` setting names a
  shell, a command runs in the shell the agent's own commands get. In a chat bound to a remote
  target it runs on the target, in its folder, as the agent's commands do there.
- **The sandbox.** In a chat whose sandbox is On (§chat.sandbox/states) the command is confined
  exactly like the agent's `bash` (§chat.sandbox/what-on-enforces), in every case the agent's is: a
  chat reopened after its folder was deleted gets no writable folder in its place, a command run
  while the sandbox is being turned on is confined as On, and a sandbox setting Sova can't read
  refuses the command instead of running it under a wider policy. If the sandbox can't be prepared,
  nothing runs (§chat.sandbox/fail-closed): the reason shows under the box. A chat whose sandbox
  covers only its subagents, or is Off, runs your command unconfined, like its own agent's. On a
  remote target the sandbox isn't enforced, as for the agent's own commands there: the chat already
  reads "Sandbox on · not enforced on remote".
- **The kill guard.** On macOS your command is checked as the agent's `bash` is
  (§chat.kill-guard/refusal): a mis-written kill is refused before it runs, nothing of it runs, and
  the guard's reply shows under the box with the correct form ("Sova refused this command before it
  ran; nothing ran. …"). You can still write the exact command you mean. The guard reads an alias
  or a function by its name: it can't see what that runs.
- **No time limit.** A command runs until it ends, until someone stops it (§chat.shell-mode/who),
  until its chat closes (§chat.shell-mode/lifecycle), or until its output passes about 1 GB, when
  Sova stops it and its card says so (§chat.shell-mode/card). What it keeps is exactly its first
  1 GB of output, with no gap and nothing after. `SOVA_SHELL_OUTPUT_MAX_BYTES` sets a smaller limit,
  for tests.
- **Stopping it.** Stopping a command ends it and the processes it started that stayed in its
  process group; a command still being prepared when a stop or its chat's close comes never
  starts. With the sandbox Off, a process it started in a session of its own (a daemon, a
  `setsid` child) can outlive it.
- **No input.** A command gets no input from the box: its input is closed. One that asks for an
  answer (a password, a yes/no prompt, `read`) gets none at once and carries on as if given an
  empty answer; it never waits for one.
- **Several at once.** A chat can run several commands at the same time, each with its own card
  (§chat.shell-mode/card). Messages to the model still go meanwhile.
- **A refused command never ran.** A command Sova refuses (the kill guard, a sandbox that can't be
  prepared, a session open in a terminal, a chat closing as it starts: "The chat was closing, so
  your command didn't run.") doesn't run, gets no card, isn't saved and never reaches
  the model; the reason shows under the box and the command stays in it, so you can fix it.
- **While the model replies.** The command runs at once, beside the reply, so a command that
  changes files can meet the agent's own work. The model gets its output with your next message
  after that reply (§chat.shell-mode/model).
- **Two Stops.** The box's Stop stops only the model's reply; a command's `Stop Command` stops only
  that command.

## §chat.shell-mode/card — The command's cards and its full output

A command shows in the chat at once: while it runs, in the running bar above the message box; once
it ends, as a card in the transcript, where it stays.

```html
<!-- once it ended: in the transcript -->
<article class="shell-card" aria-label="Command you ran">
  <div class="shell-card-head">
    <code class="shell-card-command">$ pnpm test</code>
    <!-- Exit 0 (a plain chip) · Exit 1 (chip-error) · Stopped by you · Stopped (by the Stop
         Command entry) · Stopped when the chat closed · Stopped at the 1 GB output limit
         (chip-error) · Ended (no exit code given) -->
    <span class="chip">Exit 0</span>
    <!-- only when the run says how long it took -->
    <small>took 0:12</small>
  </div>
  <!-- only when there is output: its last 3 lines -->
  <pre class="shell-card-output" tabindex="0" aria-label="Output">
{the output's last 3 lines}</pre>
  <!-- only for a !! command -->
  <p class="shell-card-note">Not shared with the model</p>
  <!-- only while the reply it was run beside still runs (not for !!) -->
  <p class="shell-card-note">The model gets this after its reply.</p>
  <div class="shell-card-actions">
    <button class="button button-sm" type="button" aria-haspopup="dialog">Show Full Output</button>
  </div>
</article>
```

- **While commands run.** One quiet bar above the message box, out of the transcript's scroll, on
  every screen watching the chat: a live `{n} running` chip and the newest command with its latest
  output line (`{command}: No output yet.` while it has none).
  - **One command running.** The bar's summary is plain text, with that command's `Show Output`,
    which opens its live output, and its `Stop Command`; there is no list and no `Show All`.
  - **Two or more.** The bar is a toggle, `Show All` or `Hide`, and while the list is open `Stop
    All {n}` sits beside it. When the count drops to one, an open list collapses and the bar takes
    the one-command form; when a second command starts, `Show All` comes back with the list shut.
  - **The list.** `Show All` opens the list of running commands above the bar, oldest first: each
    row has the command, how long it has run (a clock, `0:09`, `12:30`, `1:02:05`, ticking each
    second), its latest line, `Not shared with the model` for `!!`, `Show Output`, which opens its
    live output, and `Stop Command`, which stops that command only. `Stop All` stops each running
    command that isn't already stopping, one stop each. The list shuts once nothing runs. Nothing on
    the bar or the list starts a command. While a stop is on its way, its button reads "Stopping…"
    and can't be pressed again, on the bar, the list and in the window. When a row goes, focus it
    held moves to the list's first button or the bar's (with one command left, its `Show Output`),
    else to the message box, except on a touch-only screen, where it goes nowhere so the keyboard
    doesn't come up.
- **When it ends.** It leaves the bar and its card comes into the transcript (after a reply still
  streaming, until its row is saved), with the exit code, `Exit 0`, and any other code in the error
  tone (`Exit 1`), and how long it took (`took 0:12`) when the run says so. A command you stopped
  reads `Stopped by you`; one the `Stop Command` entry stopped reads `Stopped`
  (§chat.shell-mode/who); one stopped because its chat closed reads `Stopped when the chat closed`
  (§chat.shell-mode/lifecycle); one Sova stopped at the size limit reads `Stopped at the 1 GB output
  limit`, in the error tone (§chat.shell-mode/running). The card shows the last 3 lines of its
  output and `Show Full Output`. A command Sova refuses (the kill guard, a sandbox that can't be
  prepared) never gets a card: it never ran, and the reason shows under the box, the command still
  in it (§chat.shell-mode/box).
- **The output window.** `Show Output` and `Show Full Output` open `Command Output`, a dialog: the
  command in mono with its status chip, `Not shared with the model` for `!!`, then the output in
  mono. `Close`, `Esc` or the scrim closes it; focus stays inside, a button that goes (`Stop Command`,
  `Load More`, `Try Again`) handing it to `Close`, and on closing goes back to the button that opened
  it.
  - For a running command it shows the output as it arrives, following the end unless you scrolled
    up ("No output yet." while there is none), with `Stop Command` in its foot. It stays open when
    the command ends, and says how it ended; after its own `Stop Command`, focus moves to `Close`.
  - For a finished command it shows the entire output, read from the file it was saved to about
    1 MB at a time: "Loading the output…", then the text; while more is left, the foot reads
    "Showing 1.0 MB of 3.2 MB" with `Load More`, and when the last page comes in with focus on `Load
    More`, focus moves to `Close`. An empty output reads "No output.". A command that ended but
    isn't saved yet shows the output it holds.
  - Once the chat is archived the file is gone: an info banner says "The whole output is gone."
    and "It's deleted when its chat is archived. The card still shows its last lines." A page that
    fails to load gives an error banner, "Couldn't load the output." and "{reason}. What's shown so
    far stays. Try again.", with `Try Again`. A command stopped at the size limit opens with a
    caution banner, "Stopped at the 1 GB output limit." and "It printed more than 1 GB, so Sova
    stopped it. The output up to the limit is here."
  - Anyone who can read the chat's transcript can read the whole output, a connected computer
    granted `sessions` included: `session.shell.output` (`GET /api/sessions/shell-output`) gives
    about 1 MB a page, from the file the command's own saved entry names, never a path the caller
    gives.
- **Long output.** The chat saves the last 2,000 lines or 50 KB of a command's output with its card,
  and the whole of it to a file on the chat's machine, until the chat is archived; the window reads
  that file.
- **`!!`.** The card of a command kept from the model says `Not shared with the model`.
- **Saved.** The command and its saved output are kept in the chat: they survive reloads and
  restarts and show on every device. Every saved command shows as this card, one run in pi's own
  terminal included, in place of the plain `$ command` line Sova drew before.
- **Live everywhere.** While a command runs, every screen watching the chat shows it in the bar and,
  in its window, the output so far: another device, a tab opened later, a reconnect, a server
  restart.
- **Under a reply.** A command run while the model replies takes its place under that reply once it
  ends, on every device, and stays below the reply after a reload. Until that reply ends, its card
  says `The model gets this after its reply.` (never for `!!`).
- **Never on a share page.** Share pages never show a command or its output
  (§app.session-share/never).

## §chat.shell-mode/model — What the model gets

- **`!`: with your next message.** A finished command joins the conversation quietly: the model
  gets it with your next message, as one message holding a line with the whole command and its
  output, plus a note when it was stopped and its exit code when that isn't 0. An output of 2,000
  characters (about 500 tokens) or less goes whole, with no path line, since the model has all of
  it. A longer one is cut to its last 2,000 characters, says that earlier output was cut (and how
  many characters, unless the harness had already cut it), and always ends with a line naming the
  file that holds the whole output: the harness's own file when it cut the output, else one Sova
  writes, readable only by you. The model doesn't reply on its own,
  and nothing is spent until you write. Several commands run in a row reach it together, before
  your message.
- **`!!`: nothing.** The model sees nothing of the command: not the command, not its output, not a
  line of memory, a summary or a recall (§chat.memory/log), on that turn or any later one, in every
  chat.
- **Kept from the model, not secret.** A `!!` command and its output are still saved in the chat's
  file, which the chat's own agent can read; its whole output is in a file on the chat's machine
  until the chat is archived; and a command typed in shell mode is saved in your drafts while you
  type it, readable only by you.
- **Every chat alike.** A Claude Code chat's model gets them exactly as a pi chat's does, with the
  same wording (§app/claude-code-provider).
- **Context use.** The Context tab counts a command only when it was shared with the model
  (§app.subagents-pane/context-tab).

## §chat.shell-mode/lifecycle — A running command and its chat

- **It keeps its chat running while Sova is up.** While a command runs, its chat doesn't close for
  being quiet (§app.chat-processes/idle-stop) and doesn't reload onto new code
  (§app.chat-processes/code-pickup): a running command counts as work in flight, as a reply does,
  and a `Reload Now` pressed meanwhile reads `Reloads when its command ends`.
- **Not once Sova has gone.** A chat that has had no server for its idle time stops a running
  command, as a close does, and exits (§app.chat-processes/idle-stop).
- **Closing the tab doesn't stop it.** Nor does a server restart, which the chat runs through
  (§app.chat-processes/survives-restart). Opening the chat on any device shows the output so far.
- **Closing the chat does.** Archiving or restarting the chat, or anything else that closes it,
  stops a running command, and its card is saved as `Stopped when the chat closed`; every open tab
  of the chat shows it stopped at once. The close waits up to 5 s for a stopped command to end and be
  saved. A command that ended during a reply and waits to be saved below it is saved before the
  chat goes (the close stops that reply, as it would anyway). Archiving the chat also deletes the
  files holding its commands' whole output; a chat that stops for being quiet keeps them.
- **Limit: a crash loses the run.** A chat process that crashes while a command runs, or before a
  finished one was saved, loses its card: nothing of it is saved, and the card is gone once the chat
  opens again. The command itself may go on running, since nothing is left to stop it.

## §chat.shell-mode/who — Who can start a command, and stop one

- **Only from a chat's message box.** A command runs only when someone presses Run, or `Enter`, in
  shell mode. Sova never reads a leading `!` in text: the Overseer's messages, playbooks, quick
  actions, card clicks, messages from gathering sessions and other chats, a workspace's group send
  and the `session.send` command all reach the model as text, whatever they start with.
- **No route starts one.** Running one is no catalogue entry (§app.commands/catalogue) and no route
  a script can call. `POST /api/chat/frames`, which delivers what a closing page kept
  (§chat.transcript/send-while-starting), never runs a command, and `POST /api/chat/action` only
  lists and stops them (§app/chat-actions).
- **Which sockets.** A chat socket that is neither the operator's page nor a connected computer's (a
  script's, a chat's, an extension's or the Overseer's on this computer, told apart as
  §app.access/your-click tells them) is refused every command, whatever its chat: nothing runs, and
  it hears "Only the message box can run a command. Ask the user to type it in shell mode in this
  chat's message box. Nothing ran."
- **Your other computers.** Any connected computer granted `sessions` (§mesh.peers/grants) can run
  commands wherever it can send messages, through its own Sova's relay too, with no further check:
  Sova is taken to run only on computers you trust. It can't prove a person is at it, so a script
  there can run a command here with no model involved, unconfined unless the chat's sandbox is On.
  Such a computer can already ask an agent to run the same command, as the Mesh page warns.
- **Stopping.** `Stop Command` on the running bar, in its list or in a command's output window
  stops that command, and `Stop All` stops each running one. So do the catalogue's entries (§app.commands/catalogue, §app/chat-actions), whoever
  calls them, the Overseer and scripts included: `chat.shell.list` (List Commands) lists a chat's
  running commands, each with its id, its command (none for a `!!` one) and when it started, and
  `chat.shell.stop` (Stop Command) stops one by its id and waits until it has stopped; its card then
  reads `Stopped`, not `Stopped by you`. They only
  list and stop; nothing starts a command that way. Any other `Stop` a script's, a chat's, an
  extension's or the Overseer's socket sends stops nothing.
- **A session open in a terminal** refuses a command as it refuses a message.
