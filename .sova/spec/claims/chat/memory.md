# §chat/memory — Memory
> Part of the Sova design spec · [overview](../design/overview.md)

The **memory** minor mode lets a chat outgrow its context: a cheap model folds the chat's messages
into one-line summaries (the **view**: recent lines cover one message each, older lines cover more),
and the model opens any line back down to the original message with its `zoom` tool. The transcript
the user reads never changes; only what the model is sent does, so turning memory off gives the model
the chat's full history back.

Owns: the two memory types and their credit, where memory can be turned on, each chat's own type and
the Summary size each type uses, the message log, the summary tree and the view, the summarizer, what a turn sends, the
recall tools and their rows, preparing an existing chat, recovering from failed summaries, zoomable compaction, the memory status and
outline the web shows, Settings → Memory and the overseers' switches. Not here: the mode menu's rows
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
  itself (§chat.memory/turn). Its view grows to UniiChat's Summary size (128 KB by default,
  §chat.memory/settings) and then merges down to half of it (Taelin's 64–128 KB).
- **Zoomable compaction**, Sova's: the chat stays as it is until it would compact; then the
  compacted part becomes summary lines the model can open, instead of a one-off summary
  (§chat.memory/zoomable). Its size is the size of the lines a compaction leaves (Zoomable
  compaction's Summary size, 32 KB by default).

The menu's copy is the server's (`MEMORY_TYPE_INFO`, `shared/memory.ts`): UniiChat · "by Victor
Taelin" · "One chat that never ends: every message kept, summarized into lines the model can open",
with the mode row's detail line "UniiChat — by Victor Taelin" while it is on (the link above is
"Read the design ↗" in Settings → Memory's help card, §chat.memory/help, never in a menu); Zoomable compaction · "Sova" · "The chat stays as it is; when it would
compact, older turns become summary lines the model can open instead of a one-off summary".

Sova's UniiChat is an adaptation of Taelin's design, and keeps its name and credit, "UniiChat — by
Victor Taelin". What it changes, and why:

- **The reader's guide is rewritten** (§chat.memory/turn): it calls the lines an index, not the
  record, and sends any recall to `zoom` before other tools, because an A/B evaluation of recall
  found the model answering from the lines or searching elsewhere instead of opening them.
- **The Overseer's run note adds a memory-first line** (§app.overseer/sessions-in-play): any other
  session or fact the chat has seen is zoomed down to its message (full ids, exact words) before
  any other tool, because the Overseer looked sessions up again with its own tools.
- **Ids are shown whole** (§chat.memory/full-ids): a line's shortened session id is shown whole when
  its own messages make that certain, because summaries shorten ids and a reader seeing the same
  short id on every level took it for all memory kept.

## §chat.memory/where — Where memory can be turned on

Memory runs inside Sova's server, so only Sova turns it on: from an ordinary chat's mode menu
(`POST /api/mode?path=…`, §chat.mode-menu/how-a-switch-reaches-the-chat), whatever the chat's
model, and for the Overseer and each project overseer from that overseer's own switch
(§chat.memory/overseer). Those switches are the only way: a project overseer's mode switch stays
refused, and neither overseer has a mode-menu memory row.

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

A chat's memory type is its own: a hidden `sova-memory` state record `{v: 1, type}` (§app.harness/state,
newest on the branch wins), written by `POST /api/mode?path=… { memory: { type } }`. A chat with no
record uses the saved default type (Settings' memory file `default`), else UniiChat. An overseer (the
Overseer, a project overseer) keeps no record: its type is its own switch's (§chat.memory/overseer).
Its size is never its own: every chat, and every overseer, uses the Summary size Settings → Memory
holds for its type (§chat.memory/settings), read again at each turn, so a change there reaches a
UniiChat chat at its next message and a zoomable one at its next compaction. A `size` an older record
holds is ignored, never erased; so is a `memory.size` in a `POST /api/mode` body (an older client's
pick changes nothing and is not refused). The type is kept while memory is off, survives reopen,
rewind (a rewind past the record falls back to the one before it) and restart, and reaches every tab
in the chat's `mode` message (`memory`: the type and the size it resolves to), so a change of type
alone is a new `mode` message. `Save as default` saves the type with the chat's modes, and a `POST
/api/mode` without a path saves only a type. An automation's `settings.memory` sets a session's type
the same way; a size it names is ignored. Only a chat whose menu can turn
memory on gets `memory` in its `mode` message and in a switch's result (`ChatModeResult`): a runtime
without the memory engine (a baton, another special loadout), a session that refuses mode switches
(a project overseer, whose memory is its own switch's) and the Overseer get none, so their menu shows no memory row, and a `{ memory }`
or memory-on switch there is refused before anything is written.

## §chat.memory/log — The message log and its sidecar

The engine logs the chat's **active branch**, read through the neutral reader, as numbered messages
of six kinds: `user` (the user's words, an image as `[image]`), `sova` (the model's reply text),
`tool` (one per tool call: its name and JSON arguments, `record_tour`'s supplied credentials as "[hidden]",
§app.tours/sites), `echo` (its result, clipped to its first and
last 15,000 characters; a failed one says so), `work` (a message an extension shows in the
transcript, such as a worker's report) and `note` (a branch summary). Thinking, hidden notes (mode
notes, alignment state, nudges), system and state entries are not logged. A text longer than 16,000
characters is logged as several messages in a row, never cut.

Each message records the entry it came from, so the log is derived again from the branch whenever it
is needed and a rewind or a fork is correct by construction: on load the engine compares the stored
leaves with the branch, and every summary covering a message from the first difference on is
dropped (and the view cut back to the lines before it). Summaries live beside the chat in
`<agent dir>/sova/memory/<session id>/` (`tree.jsonl` the built nodes, `state.json` the views and
their saved prefixes, `retry.json` the failed summaries' tries and retry times, §chat.memory/recovery); "Fork from here" copies the source chat's directory to the fork (when the
source has one and the fork has none), and the fork keeps what still matches its own branch. Turning memory off keeps
them, so turning it back on only summarizes what came after; deleting or archiving the chat deletes
them.

## §chat.memory/tree — The summary tree and the view

Following Taelin's design: message `i` is node `(0, i)`; node `(l, i)` merges `(l-1, 2i)` and
`(l-1, 2i+1)` and covers the 2^l messages from `i·2^l` on, named `id+n`. A source that fits in 512
bytes is its own node with no model call (two short lines are joined by a newline); every other node
is one summarizer call asked for 512 bytes with a 512-character ruler, accepted up to 768 bytes, and a
longer reply is cut at its last sentence end within 768 bytes, never asked again. Each node is built
once; a node whose summary keeps failing is tried again later on its own, and after its third failed
try its line is a clipped excerpt instead (§chat.memory/recovery).

The view is a list of nodes covering every message, oldest first; each new message appends its line.
Once the view passes the chat's size it merges, in one batch, the most due sibling pair whose parent
is built (due = (T − the pair's last message) / 2^l; the oldest pair wins a tie), again and again
until it is at most half the size; a batch that can't reach half yet merges what it can at each new
message until it does. The view is saved and never rebuilt from the log, except after a rewind or a
fork. Nodes ready to build wait in a queue (never a scan of the tree), up to 4 calls at once: leaves
first, then merges, except while the summarizer's compaction view is over its size
(§chat.memory/summarizer): then a merge that combines two of its lines goes before every leaf. A
merge is ready once both halves are built, and merges are built in the background as soon as they
are.

## §chat.memory/summarizer — Who writes the summaries

The summarizer is a one-shot model call, never a session: by default Claude Code `claude-haiku-5-5`
at low effort, changeable in Settings → Memory with a fallback (§chat.memory/settings). Each call
respects the model policy (a refused model is skipped for the fallback), claims a slot of its
provider's request limit as background work, runs on this host's Claude login like Sova's other
one-shots, and is recorded in the usage ledger as the chat's own spend with purpose `memory`. Its
system prompt is the compaction guide (adapted from Taelin's §4–§5) followed by a stable prefix of
the chat's **compaction view** (the view merged further, to 16–32 KB, saved beside it), so calls read
it from the prompt cache; the lines after the prefix and the task go in the message. The summarizer
keeps its own instructions only: a Claude Code call gets its system prompt from a private temporary
file (`--system-prompt-file`, which replaces Claude Code's own instructions, nothing added to them),
written readable by its owner only and removed when the call ends, never on the command line, so no
size keeps it from starting (§app.decisions/providers bounds every one-shot's arguments); a pi call
takes it as the call's system prompt.

The compaction view is merged down with the merges already built before every summary and whenever
a merge is built, not only when a message arrives, and while it is over 32 KB a merge that combines
two of its lines is built before any new message's leaf (§chat.memory/tree). One summary's context lines are capped at 64 KB: past that the oldest lines are
left out, in fixed steps of 16 KB counted from the view's first line, behind a line saying which
messages are left out, so back-to-back summaries share the same prefix and its cache; a prefix over
the cap is never saved. Each call is bounded by its own deadline and budget cap, with no other
spending cap. What a failed call does next: §chat.memory/recovery.

## §chat.memory/turn — What a UniiChat turn sends

With UniiChat on, each request of a turn sends, after the chat's usual system prompt and tools: one
**view message** — the memory guide, then the view of every message before the turn, as `<chat>` lines `id+n|text` — then the
chat's standing mode notes, then the turn itself whole (the message that started it, the hidden
notes it carries, and every reply, tool call, result and steer since). The view is rendered once, at
the turn's first request, and is the same for the turn's every request.

- **The guide.** It holds no date, id or state, so it stays a stable cache prefix. It tells the
  model the view is the chat's history as an index of one-line summaries, oldest first, with the
  message kinds and that older lines merge pairs; that lines are the index, not the record: every
  message is kept whole under its line, tool results included, while lines shorten names and
  numbers (ids are shown whole, §chat.memory/full-ids). Whenever the model needs anything the chat has seen, it finds the latest mention in the
  view and zooms, halving n down to the message, before any other tool and before it acts, guesses
  or asks; it never greps or reads the chat's transcript or memory files, and uses other tools only
  for what the view never mentions or to check what is true now. Its wording was chosen by an A/B
  evaluation of recall against the earlier wording.

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
or messages. The zoom tool's description says it recalls anything from earlier in the chat (a
session, its full id, a branch, a number, what was said), that every message is kept whole under its
memory line, and to use it before searching. Each call is a tool row like any other, whose folded line reads what it opened:
"Recalled messages 40–47", "Recalled message 40", "Date of message 40".

## §chat.memory/full-ids — Ids shown whole

Summary lines often shorten a session id (a UUID such as `0190f3a2-1b2c-7d4e-8f90-a1b2c3d4e5f6`) to
its first 8 hex digits or a part of it, and the same short id then repeats on every level down to
the leaf. So a line is shown with its ids whole where its own messages make that certain: in line
`id+n`, a token of at least 8 hex digits, optionally continued by hyphenated hex groups (such as
`0190f3a2-1b2c`), standing alone (no letter, digit, `_` or `-` right before or after it), that is not
itself a whole UUID and begins exactly one of the distinct UUIDs in messages `id` to `id+n−1` as
logged (§chat.memory/log, tool calls and results included), is shown as that UUID. A token that
begins none of them, or more than one, is shown as written; no UUID from outside the line's own
messages is ever used.

It applies wherever a line is shown: a UniiChat turn's view, `zoom`'s two lines, a zoomable
compaction's summary, and the Memory outline (§chat.memory/status). It never rewrites the stored
summaries (`tree.jsonl`), and the summarizer never sees it: the two lines a merge is asked to merge
and the compaction view it reads as context are the stored lines, and the view's merges are decided
on the stored lines' sizes. A line's shown text depends only on its stored text and its own messages, so it reads
the same at every turn and the view's cached prefix stays byte-stable; a chat whose saved prefix
predates it rebases once.

## §chat.memory/preparing — Turning memory on in a chat with history

Turning memory on in a chat that already has messages prepares it in the background: every message
not summarized yet is queued, and until the view covers the chat, turns go out exactly as without
memory. The status reads "Preparing memory: 120 of 480 messages" (messages summarized of messages
logged). Memory applies from the first turn after the leaves are built. A message whose summary keeps
failing never holds preparing up for good: the others carry on, and after its third failed try its
line is an excerpt (§chat.memory/recovery).

A chat whose memory is on but was never prepared (no view built yet: an overseer that is on by
default and already has history, §chat.memory/overseer, or a chat whose preparing a restart cut
short) is prepared the same way, with the same status, from the first time the engine reads its
branch with memory on: its runtime opening, or its next turn. Its turns go out as without memory
meanwhile; a chat whose view was built once is never prepared again.

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
the merges still being written), each but off with an optional `problem` sentence. The `problem`
shows only while every summary is paused, says when they are tried again, and clears at the next
summary that succeeds (§chat.memory/recovery); a single message that keeps failing never sets it. `GET
/api/memory?path=…` gives the lines the model sees now (UniiChat: the next turn's view; zoomable: the
newest compaction's lines) with each line's first and last transcript entry, and `GET
/api/memory/open?path=…&id=&n=` the two lines under a line, or a message whole, for the Session
pane's read-only Memory outline. Their lines read as the model is shown them, ids whole where
certain (§chat.memory/full-ids).

## §chat.memory/recovery — When summaries fail

A chat's memory recovers from failed summaries on its own, with no new message needed, and one
message that keeps failing never blocks the rest.

- **A failure that stops every summary** pauses the whole queue: the summarizer's login failed, it
  hit a usage or rate limit, the model policy refuses its model, or it can't run at all (Claude Code
  not installed); or a failure that says nothing about the message: a timeout (waiting for a Claude
  Code slot, or a run killed at its deadline), a network error, an overloaded provider. The message
  goes back in the queue and the try isn't counted. The queue tries again by itself after 5 minutes, then 10, 20, 40 and at most 60
  between tries; a new message lifts the pause at once. The status's `problem` names the cause and
  the time of the next try, e.g. "The memory summarizer's login failed: check Settings → Accounts.
  Retrying at 2:05 PM.", and clears at the next summary that succeeds.
- **A failure that points at the message itself belongs to its node** (a malformed or empty reply,
  a reading too large, a request the provider refuses as malformed, an unexplained provider error): that node waits and is tried again by itself, 5 minutes after its first
  failed try and 2 hours after its second, while every other node carries on; it sets no `problem`.
  After its third failed try, a message's line is its own text clipped to 512 bytes at a sentence end
  (a merge's: its two lines, clipped to 768), marked as an excerpt in `tree.jsonl`; the whole message
  stays one `zoom` away. A new message doesn't reset a node's tries.
- **Many failing in a row**: when 8 different nodes fail one after another with no success between,
  the summarizer counts as down and the queue pauses as for a failure that stops every summary, its
  `problem` reading "Memory summaries are failing: …" with the time of the next try; the tries already
  counted stay counted.
- **Saved.** Each node's tries and next try, and the pause's next try, are kept in the chat's
  sidecar (`retry.json`, §chat.memory/log), so a chat whose process reloads or exits while idle picks
  up where it left off. A rewind or fork drops those past the first changed message.
- **Repair on load.** The first time the running chat's engine reads its branch, it merges the
  compaction view down with the merges already built, throws away a saved prefix over the 64 KB cap
  (§chat.memory/summarizer), queues every ready merge and sets its retry timers. Reading a chat no
  runtime holds (the Memory outline of a closed chat) builds nothing, writes nothing and starts no
  timer.

## §chat.memory/settings — Settings → Memory

`<agent dir>/mode-memory.json` `{version: 1, summarizer: {primary, fallback}, sizes, default?}` holds
the summarizer (a backend, model and effort, plus an optional fallback, like the spec writer), the
Summary size of each type that every chat and every overseer use (`sizes: {uniichat, zoomable}`, whole
KB from 8 to 512; 128 and 32 by default, `MEMORY_TYPE_INFO`'s `defaultSize`) and the memory type new
chats start from (`default: {type}`). A missing or malformed file reads as the defaults, and a missing
or malformed size as its type's default. A `size` an older file's `default` holds becomes that type's
size once, when `sizes` names none for it, before anything rewrites the default; the default is
written without it from then on. `GET /api/settings/memory` and `PUT /api/settings/memory` read and
replace the summarizer and the sizes (a PUT without `sizes` keeps the stored ones, and one without
`default` keeps the stored default); the write is atomic, a size outside 8–512 KB is refused, and a
model the policy refuses or that can't be verified saves with a warning.

## §chat.memory/help — How memory works

Settings → Memory has a small `?` button beside its heading (accessible name "How memory works",
`aria-expanded` while open). With a mouse, hovering it (or focusing it from the keyboard) shows the
one-line hint "How memory works"; a click or a tap opens the explanation, so a phone never needs
hover. It opens as a small card anchored to the button, and as a bottom sheet below the 768px
breakpoint, over a dimmed backdrop. It is a labelled dialog with an × button. Escape (which leaves
Settings open) and the × close it with focus back on the `?`; so does a click or tap outside it, or
focus moving out of it, leaving focus where the user put it. A tap outside the sheet closes only the
sheet.

It has two tabs, UniiChat and Zoomable compaction, opening on the saved default type when Settings
has one, else UniiChat. Each tab says in 3–4 plain sentences how its type works and shows 2 static
drawings drawn by the chat's own `vis` renderer (no Source or Copy, no model call): UniiChat's what
the model reads each turn and how lines merge and open back into messages, crediting "by Victor
Taelin" with "Read the design ↗" (§chat.memory/types); Zoomable compaction's the chat before and
after it compacts. Under the tabs, "What the settings change" says what Summary size (set on this
page, one for each type, in the same words as its section, §app.settings-dialog/memory) and the
summarizer's model and effort (this page; Haiku 5.5 at low effort by default) trade off. Its figures are the engine's: lines asked for at about 500
characters, the sizes and defaults of `shared/memory.ts`, and a turn's 20-second wait
(§chat.memory/tree, §chat.memory/turn, §chat.memory/zoomable). The `?` and its card or sheet are one
reusable component.

## §chat.memory/overseer — The Overseer's memory

The Overseer has no mode menu; its memory is a switch of its own, `GET`/`PUT /api/overseer/memory`
`{on, type}`, kept in `overseer.json` (`memory`) and read at each of its turns. Its size is
Settings → Memory's for its type, like any chat's (§chat.memory/choice): both routes report that size,
a PUT's `size` is ignored (not refused), and a size an older `overseer.json` holds is ignored and
kept. Each project
overseer has the same switch of its own, `GET`/`PUT /api/projects/:pid/overseer/memory`, kept in
that project's overseer `overseer.json` (§app.project-overseer/identity, §app.project-overseer/memory-switch).
Changing one never changes the Overseer's or another project's.

- **On by default.** An overseer with no saved choice has memory on with UniiChat (at Settings'
  UniiChat size, 128 KB by default), whatever
  default Settings → Memory saved for ordinary chats; both routes report it so, and so does its
  Memory outline (`GET /api/memory?path=…`), held or not. Switched off, it
  stays off until someone switches it on again. Clear keeps the choice: it is the overseer's, not
  its conversation's. Only its switch writes it: a Settings → Overseer save (and the proactivity
  cycle, which saves the same settings) keeps the stored switch whatever its body carries.
- **An existing conversation** on by default is prepared in the background from its runtime's next
  open or its next turn, whichever comes first (§chat.memory/preparing), its run-status row
  showing "Preparing memory: n of m messages", and it answers as without memory meanwhile.
- With it on, the overseer runs the same engine as a chat (its tools include `zoom` and `date`),
  on Claude Code as on pi. It never reaches the coding sessions either overseer starts
  (§chat.memory/where).
