# §chat/memory — Memory
> Part of the Sova design spec · [overview](../design/overview.md)

The **memory** minor mode lets a chat outgrow its context: a cheap model folds the chat's messages
into one-line summaries (the **view**: recent lines cover one message each, older lines cover more),
and the model opens any line back down to the original message with its `zoom` tool. The transcript
the user reads never changes; only what the model is sent does, so turning memory off gives the model
the chat's full history back.

Owns: the two memory types and their credit, where memory can be turned on, each chat's own type and
view size, the message log, the summary tree and the view, the summarizer, what a turn sends, the
recall tools and their rows, preparing an existing chat, zoomable compaction, the memory status and
outline the web shows, Settings → Memory and the Overseer's switch. Not here: the mode menu's rows
and Save as default (§chat/mode-menu), and how a Claude Code chat's CLI takes a request
(§app/claude-code-provider).

The engine is Sova's, server-side and harness-neutral (`server/memory/`): the mode extension only
knows the minor mode's name and where it may be turned on. Memory is no part of Claude Code's own
auto-memory, which Sova keeps off (§app.claude-code-provider/no-memory).

## §chat.memory/types — Two types: UniiChat and zoomable compaction

A chat with memory on uses one of two types, and each chat keeps its own.

- **UniiChat**, by Victor Taelin (his design: https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449):
  one chat that never ends. Every message is kept, summarized into lines the model can open; each
  turn sends the model a memory guide, the view of the whole chat before the turn, and the turn
  itself (§chat.memory/turn). Its view grows to the chat's size (128 KB by default) and then merges
  down to half of it (Taelin's 64–128 KB).
- **Zoomable compaction**, Sova's: the chat stays as it is until it would compact; then the
  compacted part becomes summary lines the model can open, instead of a one-off summary
  (§chat.memory/zoomable). Its size is the size of the lines a compaction leaves (32 KB by default).

The menu's copy is the server's (`MEMORY_TYPE_INFO`, `shared/memory.ts`): UniiChat · "by Victor
Taelin" · "One chat that never ends: every message kept, summarized into lines the model can open"
· "Read the design ↗" (the link above), with the mode row's detail line "UniiChat — by Victor
Taelin" while it is on; Zoomable compaction · "Sova" · "The chat stays as it is; when it would
compact, older turns become summary lines the model can open instead of a one-off summary".

## §chat.memory/where — Where memory can be turned on

Memory runs inside Sova's server, so only Sova turns it on: from an ordinary chat's mode menu
(`POST /api/mode?path=…`, §chat.mode-menu/how-a-switch-reaches-the-chat), whatever the chat's
model, and for the Overseer from its own switch (§chat.memory/overseer).

- The mode extension declares it web-only (`MINOR_SURFACES` in `pi-config/extensions/mode/minor.ts`,
  a record over every minor mode). Its `/mode memory on` takes effect only while Sova's server is
  applying a switch for that very session (the server's `sova:web-minor` hook); typed by hand (in a
  terminal or a web composer), and from `--minor`, it is refused with "memory is turned on from a
  Sova chat's mode menu". The terminal palette and minor shortcuts don't list it. Turning it off is
  never refused, and a switch sends it `/mode memory off` only in a chat where memory was on.
- Workers never get it (`MINOR_WORKER.memory` is false, §chat.mode-menu/workers).
- A session profile naming it is refused ("memory is for chats only: turn it on from a chat's mode
  menu"), and so is a switch of a baton or project-overseer session (400).
- The Overseer may have memory itself, but the coding sessions it starts or sets never get it: its
  `sova_create_session` and `sova_set_session` (here or on a peer) refuse a `minor_modes` list naming
  memory before anything is created or changed, and the peer route they reach (`POST
  /api/sessions/configure`) refuses it too (400), with "Memory is for chats only: the user turns it
  on from a chat's mode menu, never in a coding session". Either Overseer's coding-session request
  naming memory (the project overseer's `sova_create_session` and `sova_send`, the Overseer's
  `sova_project_overseer` `code`) is refused the same way, before anything is created or sent; and a
  coding session that names no minor modes starts on this computer's default without memory, even
  when the saved default has it on.
- A session whose saved mode has memory on (a web chat later opened in a terminal) keeps it in its
  saved mode, but nothing runs it there.
- A saved default with memory on (`/mode default` or the menu's save, from a chat with memory) stays
  in `mode.json` as saved, and a new or never-switched web chat starts with it. A terminal session
  adopting that default (or a branch without a saved mode, after `/tree`) drops memory: its status
  line, `/mode status`'s `minor:` line (its `default:` line still shows the file) and the active
  minor modes it publishes don't list it. The extension tells the two
  apart by the server's `sova:web-minor` hook, which Sova's server installs when it loads.

## §chat.memory/choice — Each chat's type and size

A chat's memory type and view size are its own: a hidden `sova-memory` state record `{v: 1, type,
size}` (§app.harness/state, newest on the branch wins), written by `POST /api/mode?path=… { memory }`.
A chat with no record uses the saved default (Settings' memory file `default`), else UniiChat at
128 KB. The choice is kept while memory is off, survives reopen, rewind (a rewind past the record
falls back to the one before it) and restart, and reaches every tab in the chat's `mode` message
(`memory`), so a change of type alone is a new `mode` message. `Save as default` saves it with the
chat's modes; the size accepts any whole number of KB from 8 to 512. Only a chat whose menu can turn
memory on gets `memory` in its `mode` message and in a switch's result (`ChatModeResult`): a runtime
without the memory engine (a baton, a project overseer, another special loadout), a session that
refuses mode switches and the Overseer get none, so their menu shows no memory row, and a `{ memory }`
or memory-on switch there is refused before anything is written.

## §chat.memory/log — The message log and its sidecar

The engine logs the chat's **active branch**, read through the neutral reader, as numbered messages
of six kinds: `user` (the user's words, an image as `[image]`), `sova` (the model's reply text),
`tool` (one per tool call: its name and JSON arguments), `echo` (its result, clipped to its first and
last 15,000 characters; a failed one says so), `work` (a message an extension shows in the
transcript, such as a worker's report) and `note` (a branch summary). Thinking, hidden notes (mode
notes, alignment state, nudges), system and state entries are not logged. A text longer than 16,000
characters is logged as several messages in a row, never cut.

Each message records the entry it came from, so the log is derived again from the branch whenever it
is needed and a rewind or a fork is correct by construction: on load the engine compares the stored
leaves with the branch, and every summary covering a message from the first difference on is
dropped (and the view cut back to the lines before it). Summaries live beside the chat in
`<agent dir>/sova/memory/<session id>/` (`tree.jsonl` the built nodes, `state.json` the views and
their saved prefixes); "Fork from here" copies the source chat's directory to the fork (when the
source has one and the fork has none), and the fork keeps what still matches its own branch. Turning memory off keeps
them, so turning it back on only summarizes what came after; deleting or archiving the chat deletes
them.

## §chat.memory/tree — The summary tree and the view

Following Taelin's design: message `i` is node `(0, i)`; node `(l, i)` merges `(l-1, 2i)` and
`(l-1, 2i+1)` and covers the 2^l messages from `i·2^l` on, named `id+n`. A source that fits in 512
bytes is its own node with no model call (two short lines are joined by a newline); every other node
is one summarizer call asked for 512 bytes with a 512-character ruler, accepted up to 768 bytes, and a
longer reply is cut at its last sentence end within 768 bytes, never asked again. Each node is built
once.

The view is a list of nodes covering every message, oldest first; each new message appends its line.
Once the view passes the chat's size it merges, in one batch, the most due sibling pair whose parent
is built (due = (T − the pair's last message) / 2^l; the oldest pair wins a tie), again and again
until it is at most half the size; a batch that can't reach half yet merges what it can at each new
message until it does. The view is saved and never rebuilt from the log, except after a rewind or a
fork. Nodes ready to build wait in a queue (never a scan of the tree), leaves first, up to 4 calls at
once; a merge is ready once both halves are built, and merges are built in the background as soon as
they are.

## §chat.memory/summarizer — Who writes the summaries

The summarizer is a one-shot model call, never a session: by default Claude Code `claude-haiku-5-5`
at low effort, changeable in Settings → Memory with a fallback (§chat.memory/settings). Each call
respects the model policy (a refused model is skipped for the fallback), claims a slot of its
provider's request limit as background work, runs on this host's Claude login like Sova's other
one-shots, and is recorded in the usage ledger as the chat's own spend with purpose `memory`. Its
system prompt is the compaction guide (adapted from Taelin's §4–§5) followed by a stable prefix of
the chat's **compaction view** (the view merged further, to 16–32 KB, saved beside it), so calls read
it from the prompt cache; the lines after the prefix and the task go in the message. A failed call
is tried again at the next message; while the summarizer can't run at all the status says why.

## §chat.memory/turn — What a UniiChat turn sends

With UniiChat on, each request of a turn sends, after the chat's usual system prompt and tools: one
**view message** — the memory guide (Taelin's §5, the agent unnamed, device and subagent paragraphs
left out), then the view of every message before the turn, as `<chat>` lines `id+n|text` — then the
chat's standing mode notes, then the turn itself whole (the message that started it, the hidden
notes it carries, and every reply, tool call, result and steer since). The view is rendered once, at
the turn's first request, and is the same for the turn's every request.

- **Wait.** Before the first request, the turn waits for the newest messages' summaries, at most
  20 seconds, then goes on anyway (a line not summarized yet reads "(not summarized yet: zoom it)");
  the composer shows "Updating memory…" meanwhile. Merges never hold a turn.
- **The cache split.** The engine keeps a stable prefix of the view's lines and saves it beside the
  chat, with the bytes of newer lines the turns have sent since it was renewed. A rebase (the whole
  view becoming the prefix) re-writes the prefix's cached block, counted as the chat's system prompt,
  the guide and the prefix; a turn that keeps it re-writes only the newer lines. So the prefix is kept
  while it still leads the view and the newer lines sent since it was renewed, this turn's included,
  total at most that block (and at least 1,536 bytes); else the turn rebases. A merge batch that
  rewrites a prefix line always rebases. With newer lines growing g bytes a turn, a chat rebases about
  every √(2 · block / g) turns. The view
  message carries the guide with the prefix as one text block and the newer lines as another, and the
  guide tells the model the view may come in two places, read as one list.
- **No compaction.** A UniiChat chat never compacts: pi's own compaction, Claude Code's automatic one
  and `compact-handoff` are cancelled, and a `/compact` from the web is answered "Memory (UniiChat)
  is on: this chat doesn't compact; the model works from its memory."
- Memory's own switch changes what history is sent and never the system prompt; a chat that turns it
  off sends its full history from its next turn.

## §chat.memory/recall — Opening a line

While memory is on the model has two tools: `zoom(id, n)` opens line `id+n` into the two lines it was
made from, and `zoom(id, 1)` gives message `id` whole; `date(id)` gives message `id`'s date and time.
`n` must be a power of 2 and `id` a multiple of it; a line not built yet opens into its own halves
or messages. Each call is a tool row like any other, whose folded line reads what it opened:
"Recalled messages 40–47", "Recalled message 40", "Date of message 40".

## §chat.memory/preparing — Turning memory on in a chat with history

Turning memory on in a chat that already has messages prepares it in the background: every message
not summarized yet is queued, and until the view covers the chat, turns go out exactly as without
memory. The status reads "Preparing memory: 120 of 480 messages" (messages summarized of messages
logged). Memory applies from the first turn after the leaves are built.

## §chat.memory/zoomable — Zoomable compaction

With zoomable compaction on, the chat's turns go out as without memory, while every message is
summarized in the background as with UniiChat. When the chat compacts — pi's automatic compaction,
a `/compact`, Claude Code's automatic one or `compact-handoff` — the compaction's summary is replaced
by the view of the compacted messages, merged down to the chat's size, under a short explanation of
the lines and the `zoom` tool; the kept recent part stays as pi chose it. A message not summarized
when it compacts waits at most 20 seconds, then shows as not summarized yet. Each later compaction
writes the view of everything it compacts again.

## §chat.memory/status — Status and outline

The chat's WebSocket gets `memory_status` after hello and on every change, only from a runtime with
the memory engine: `off`, `preparing` (done of total), `updating` (a turn waiting), or `ready` (with
the merges still being written), each but off with an optional `problem` sentence. `GET
/api/memory?path=…` gives the lines the model sees now (UniiChat: the next turn's view; zoomable: the
newest compaction's lines) with each line's first and last transcript entry, and `GET
/api/memory/open?path=…&id=&n=` the two lines under a line, or a message whole, for the Session
pane's read-only Memory outline.

## §chat.memory/settings — Settings → Memory

`<agent dir>/mode-memory.json` `{version: 1, summarizer: {primary, fallback}, default?}` holds the
summarizer (a backend, model and effort, plus an optional fallback, like the spec writer) and the
memory choice new chats start from. A missing or malformed file reads as the defaults. `GET
/api/settings/memory` and `PUT /api/settings/memory` read and replace the summarizer (a PUT without
`default` keeps the stored one); the write is atomic, and a model the policy refuses or that can't be
verified saves with a warning.

## §chat.memory/overseer — The Overseer's memory

The Overseer has no mode menu; its memory is a switch of its own, `GET`/`PUT /api/overseer/memory`
`{on, type, size}`, kept in `overseer.json` and read at each of its turns. With it on, the Overseer
runs the same engine as a chat (its tools include `zoom` and `date`). It never reaches the coding
sessions the Overseer starts.
