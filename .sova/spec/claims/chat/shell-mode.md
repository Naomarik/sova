# §chat/shell-mode — Shell mode: running a command from the message box

> Part of the Sova design spec · [overview](../design/overview.md)

Typing `!` into a chat's empty message box turns it into a shell box: what you write there runs as
a shell command in the chat's folder, and the command and its output show as a card in the chat
instead of going to the model as a message. The model gets the command and its output with your
next message and doesn't reply to them on its own; `!!` runs a command the model never sees. These
are pi's own `!` and `!!`, which Sova runs from the message box and nowhere else.

Owns: entering and leaving shell mode and how the box looks in it, where and how a command runs
(its folder, its sandbox, the kill guard, one at a time, stopping it), the command's card, what the
model gets, what a running command does to its chat, and who can start one. Not here: the composer
it lives in (§chat/composer), the transcript that holds the card (§chat.transcript/transcript-items),
what the sandbox confines (§chat/sandbox), what the kill guard refuses (§chat/kill-guard), and the
priority commands run at (§app.load-priority/workers).

## §chat.shell-mode/box — Entering and leaving shell mode

In the message box of every chat with its own agent and folder (an ordinary chat, a Claude Code
chat, a worker's, a team member's and a coordinator's), typing `!` into the empty box switches it
to shell mode.

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
  that command's output never reaches the model (§chat.shell-mode/model). Its placeholder reads
  `Run a command in {folder}, not shared with the model…`. A third `!` is the command's own.
- **Leaving.** Backspace or `Esc` in the empty box leaves shell mode for a message box. From `!!`,
  Backspace goes back to `!` and `Esc` to a message box. After a command runs, the box is a message
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
  changed meanwhile. A command Sova refuses (the kill guard, a sandbox that can't be prepared, one
  already running: "A command is already running in this chat.") stays in the box with the reason
  under it, in the composer's reason line, on a line of its own under the foot's controls (which keep
  their size), what it quotes in backticks drawn as code; it never ran, isn't saved and never
  reaches the model. A Run while the chat is still connecting sends nothing, then or later, and the
  box says "Not connected yet. Run it again once the chat connects." until it has. With no open connection nothing is sent and the box says "Not connected. Run it again once the
  chat reconnects."; in a chat closed for being quiet, that Run also starts the chat. When the
  connection drops before the chat answers, the reconnect answers instead: the box empties if the
  command started, else it says "The connection dropped before the chat answered. Check the chat
  before you run it again." Whether a chat has shell mode is the chat's own word, in its first
  message to the page.
- **A message coming back.** A message handed back to the box (Stop's queued message) or staged in
  it (a card's text for your next message) while it is in shell mode turns it into a message box,
  and a command already typed stays in it as plain text with its leading `!` or `!!` in view.
- **Drafts.** A draft written in shell mode is kept with its leading `!` or `!!` (§chat.composer/behavior,
  "Drafts"), so a reload, a switch back or another device opens the box in shell mode with the
  command in it.
- **Where there is no shell mode.** A session open in a terminal stays read only. The Overseer,
  project overseers, project assistants and gathering sessions have none, because their agents have
  no shell, and a workspace's group composer has none either (§workspace.groups/the-group-composer).
  In each of them a leading `!` is text, sent as written, as is a `!` in a `/btw` side question.
  Each composer has shell mode only where its chat gives it, so a new composer never gets it by
  accident.

## §chat.shell-mode/running — Where and how a command runs

- **Where.** In the chat's folder, with the shell and the environment the agent's own commands get,
  at the same lowered priority (§app.load-priority/workers). In a chat bound to a remote target it
  runs on the target, in its folder, as the agent's commands do there.
- **The sandbox.** In a chat whose sandbox is On (§chat.sandbox/states) the command is confined
  exactly like the agent's `bash` (§chat.sandbox/what-on-enforces). If the sandbox can't be
  prepared, nothing runs (§chat.sandbox/fail-closed): the reason shows under the box. A chat whose sandbox
  covers only its subagents, or is Off, runs your command unconfined, like its own agent's. On a
  remote target the sandbox isn't enforced, as for the agent's own commands there: the chat already
  reads "Sandbox on · not enforced on remote".
- **The kill guard.** On macOS your command is checked as the agent's `bash` is
  (§chat.kill-guard/refusal): a mis-written kill is refused before it runs, nothing of it runs, and
  the guard's reply shows under the box with the correct form ("Sova refused this command before it
  ran; nothing ran. …"). You can still write the exact command you mean.
- **No time limit.** A command runs until it ends, until you press `Stop Command` on its card, or
  until its chat closes (§chat.shell-mode/lifecycle). Stopping it ends the command and everything it
  started. A command gets no input from the box: one that waits for an answer (a password, an
  editor, a yes/no prompt) waits until it is stopped.
- **One at a time.** A chat runs one command at a time. Pressing Run while one runs is refused, with
  "A command is already running in this chat." under the box. Messages to the model still go
  meanwhile.
- **A refused command never ran.** A command Sova refuses (the kill guard, a sandbox that can't be
  prepared, one already running, a session open in a terminal) doesn't run, gets no card, isn't saved
  and never reaches the model; the reason shows under the box and the command stays in it, so you can
  fix it.
- **While the model replies.** The command runs at once, beside the reply, so a command that
  changes files can meet the agent's own work. The model gets its output with your next message
  after that reply (§chat.shell-mode/model).
- **Two Stops.** The box's Stop stops only the model's reply; the card's `Stop Command` stops only
  the command.

## §chat.shell-mode/card — The command's card

The command shows in the chat at once, as a card, and stays there.

```html
<article class="shell-card" aria-label="Command you ran">
  <div class="shell-card-head">
    <code class="shell-card-command">$ pnpm test</code>
    <!-- running: the accent chip with the live dot; ended: Exit 0 (a plain chip) · Exit 1
         (chip-error) · Stopped by you · Stopped when the chat closed · Ended (no exit code given) -->
    <span class="chip chip-accent chip-live"
      ><i class="chip-dot"></i>Running</span
    >
    <!-- while it runs only -->
    <button
      class="button button-sm button-destructive shell-card-stop"
      type="button"
    >
      Stop Command
    </button>
  </div>
  <!-- only when there is output; it keeps following its end while it runs and you are at the end -->
  <pre class="shell-card-output" tabindex="0" aria-label="Output">
{the output so far}</pre>
  <!-- only when the output was cut: which limit cut it, and where the whole went -->
  <p class="shell-card-note">
    Showing the last 2,000 lines · the whole output is in
    <code>/tmp/pi-bash-….log</code>
  </p>
  <!-- only for a !! command -->
  <p class="shell-card-note">Not shared with the model</p>
  <!-- only while the reply it was run beside still runs (not for !!) -->
  <p class="shell-card-note">The model gets this after its reply.</p>
</article>
```

- **While it runs.** The command in mono, then its output as it arrives, a live dot with `Running`,
  and `Stop Command`.
- **When it ends.** The exit code, `Exit 0`, and any other code in the error tone (`Exit 1`). A
  command you stopped reads `Stopped by you`; one stopped because its chat closed reads
  `Stopped when the chat closed` (§chat.shell-mode/lifecycle). A command Sova refuses (the kill
  guard, a sandbox that can't be prepared, one already running) never gets a card: it never ran,
  and the reason shows under the box, the command still in it (§chat.shell-mode/box).
- **Long output.** The chat keeps the last 2,000 lines or 50 KB of a command's output, and saves the
  whole of it to a file on the chat's machine. A card whose output was cut says which limit cut it,
  `Showing the last 2,000 lines` or `Showing the last 50 KB`, and where the whole output is. A card
  opens at the end of its output, where the latest lines are.
- **`!!`.** The card of a command kept from the model says `Not shared with the model`.
- **Saved.** The command and its output are saved in the chat: they survive reloads and restarts
  and show on every device. Every saved command shows as this card, one run in pi's own terminal
  included, in place of the plain `$ command` line Sova drew before.
- **Live everywhere.** While a command runs, every screen of the chat shows its card and the output
  so far: another device, a tab opened later, a reconnect, a server restart.
- **Under a reply.** A command run while the model replies shows under that reply on every device,
  both while it runs and once it ends, and stays below the reply after a reload. Until that reply
  ends, its card says `The model gets this after its reply.` (never for `!!`).
- **Never on a share page.** Share pages never show a command or its output
  (§app.session-share/never).

## §chat.shell-mode/model — What the model gets

- **`!`: with your next message.** The command and its output join the conversation quietly: the
  model gets them with your next message, as a message holding the command and its output, with a
  note when it was stopped, its exit code when that isn't 0, and where the whole output was saved
  when it was cut. The model doesn't reply on its own, and nothing is spent until you write. Several
  commands run in a row reach it together, before your message.
- **`!!`: never.** The command and its output are saved for you alone and never sent to the model.
- **Every chat alike.** A Claude Code chat's model gets them exactly as a pi chat's does, with the
  same wording (§app/claude-code-provider).
- **Context use.** The Context tab counts a command only when it was shared with the model
  (§app.subagents-pane/context-tab).

## §chat.shell-mode/lifecycle — A running command and its chat

- **It keeps its chat running.** While a command runs, its chat doesn't close for being quiet
  (§app.chat-processes/idle-stop) and doesn't reload onto new code (§app.chat-processes/code-pickup):
  a running command counts as work in flight, as a reply does.
- **Closing the tab doesn't stop it.** Nor does a server restart, which the chat runs through
  (§app.chat-processes/survives-restart). Opening the chat on any device shows the output so far.
- **Closing the chat does.** Archiving or restarting the chat, or anything else that closes it,
  stops the command, and its card is saved as `Stopped when the chat closed`. A command that ended
  during a reply and waits to be saved below it is saved before the chat goes (the close stops that
  reply, as it would anyway).
- **Limit: a crash loses the run.** A chat process that crashes while a command runs, or before a
  finished one was saved, loses it: nothing of it is saved, and its card is gone once the chat opens
  again.

## §chat.shell-mode/who — Only the message box starts one

- **Only a person at the message box.** A command runs only when someone presses Run, or `Enter`,
  in shell mode. Sova never reads a leading `!` in text: the Overseer's messages, playbooks, quick
  actions, card clicks, messages from gathering sessions and other chats, a workspace's group send
  and the `session.send` command all reach the model as text, whatever they start with.
- **No command, no route.** Running one is no catalogue entry (§app.commands/catalogue) and no route
  a script can call. `POST /api/chat/frames`, which delivers what a closing page kept
  (§chat.transcript/send-while-starting), never runs a command, and `POST /api/chat/action` takes
  none (§app/chat-actions).
- **Only the page's socket.** A chat socket that is neither the operator's page nor a peer's (a script's,
  a chat's, an extension's or the Overseer's, told apart as §app.access/your-click tells them) is refused
  every command, whatever its chat: nothing runs, and it hears "Only the message box can run a command.
  Ask the user to type it in shell mode in this chat's message box. Nothing ran." A Stop it sends stops
  nothing.
- **Your other devices.** Any device allowed to drive chats here (a peer granted `sessions`,
  §mesh.peers/grants) can use shell mode wherever it can send messages, with no further check. Such
  a device can already ask an agent to run the same command, as the Mesh page warns.
- **A session open in a terminal** refuses a command as it refuses a message.
