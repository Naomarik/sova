# §chat/wake-nudges — Wake nudges
> Part of the Sova design spec · [overview](../design/overview.md)

`wake_nudge` is a chat's own reminder. The model sets it, with no approval, and when it comes due a
message tagged `[wake_nudge n1]` starts a turn in that chat. It fires once and is gone. A nudge does
not depend on a tab, on the chat's process still running or on anyone coming back: Sova keeps it
and brings the chat back for it. A chat has the tool through the Timers group (§chat.profiles/model).
A team monitor's nudges are served by its parent (§teams.defaults/wake-nudge), and a playbook's
schedule is a different thing (§chat/schedules).

## §chat.wake-nudges/limits — Setting a nudge

- **The tool.** `schedule` (`delay` like `30s`, `5m` or `1h30m`, or an ISO `at`, with a `reason`),
  `list` and `cancel {id}`. `/nudges` lists them, `/nudges cancel <id>` cancels one and
  `/nudges clear` cancels all.
- **Limits.** At least 10 s and at most 24 hours ahead, and at most 5 pending in a chat. An `at` up
  to 60 s in the past is clamped to 10 s ahead. A `schedule` outside these is refused with the
  reason, and so is one past the wake limit (§chat.wake-nudges/wake-limit).

## §chat.wake-nudges/on-time — It fires on time, with no tab open

A nudge fires at its time whether or not a tab is open and whether or not the chat's process is
running. Nobody has to do anything.

- **Recorded outside the chat.** When a chat in Sova schedules a nudge, its due time is recorded
  with Sova at once, so Sova still knows about it after the chat shuts down or crashes, or the
  machine restarts.
- **Sova brings the chat back.** The server checks that list about every 10 s and starts a shut-down
  chat about 15 s before its nudge is due. Only one start of a chat runs at a time, however many of
  its nudges are due.
- **The chat fires it.** The chat sends its own nudge, so a nudge has one sender and fires once. The
  card and the message are the ones it always had (§chat.transcript/transcript-items).
- **A chat with a nudge still shuts down.** A pending nudge never keeps a chat's process running. It
  shuts down after 30 quiet minutes as any chat does (§app.chat-processes/idle-stop), and memory
  use stays as it was.
- **A running chat needs no server.** A chat whose process is running fires its nudge on time with
  Sova stopped.
- **A busy chat** gets the nudge after its current reply, never as an interruption.
- **A chat open in a terminal** is left alone: Sova neither starts it nor writes to it.
- **A tab showing the chat** connects when the chat comes back (§chat.transcript/instant-open), so
  the card and the reply show there.
- **A sleeping machine.** A nudge that came due while the machine slept fires once, marked late, soon
  after it wakes, whether its chat kept running or had shut down.
- **Nudges from before this.** A chat that shut down on older code, with a nudge pending, has no
  record with Sova. Its nudge fires when the chat next opens.

## §chat.wake-nudges/late — A late nudge fires once, marked late

If Sova or the machine was off when a nudge came due, the nudge still fires, once, however late it
is. There is no cut-off: unlike a playbook schedule, a nudge is never skipped for being late. When
Sova next starts, it catches up one chat at a time. A nudge more than 60 s late says so: its message
has the line `Overdue by {late} (pi was not running).` and its card shows `· {late} late`, so the
chat sees how late it is and decides what to do. Each late nudge starts a reply, so after a long
time away several chats may each run one.

## §chat.wake-nudges/wake-limit — 30 wakes without you

A chat can be woken 30 times with nothing typed by a person, then the chain stops and waits.

- **What counts.** Each fired nudge and each background job's end card
  (§app.background-jobs/end-card) counts one. A playbook schedule's fire neither counts nor resets.
- **It holds.** The count survives an idle shutdown, a reload, a crash, and a restart of Sova or the
  machine. None of these starts it again from zero.
- **Only a typed message resets it.** A message a person typed into that chat
  (§app.overseer/input-source) sets the count to zero. A message from another chat or the Overseer,
  a brief, a resume, a worker's report, or opening the chat doesn't.
- **At 30.** The 30th wake's text says `Wake limit (30) reached without user input: do not schedule
  more nudges; summarize status and wait for the user.`, and from then on `schedule` is refused with
  `Wake limit (30) reached without user input; wait for the user.` Nudges already pending still
  fire, once each, so at most 5 more. A job that ends is recorded and sends no card
  (§app.background-jobs/end-card).
- **A worker** has no composer, so nothing typed reaches it: a new instruction from its main chat
  resets its count instead. A team
  monitor's chain has its own bound (§teams.defaults/wake-nudge).

## §chat.wake-nudges/archive — Archiving cancels a nudge

Archiving a chat, in any way (§chat.transcript/instant-open, "An archived chat"), cancels every
pending nudge of that chat for good, whether its process is running or has already shut down, and
those of its workers and teams with it. Deleting a chat does the same. Sova never brings an
archived chat back for a nudge.

The cancel lasts. After you unarchive the chat, opening it or sending to it fires no old nudge and
`list` doesn't show one. A chat archived by mistake loses its reminders.

## §chat.wake-nudges/tries — A broken chat can't loop

- **At most 3 tries, with growing gaps.** A try fails when the chat doesn't start, and also when it
  starts and doesn't fire the nudge.
- **Then it waits for you.** After the last try Sova stops waking the chat for that nudge. The nudge
  stays pending and fires when the chat next opens.
- **It holds back nothing after it.** A nudge or job card that comes due later in the same chat is
  not stuck behind the one given up: Sova brings the chat back for it with its own 3 tries. The
  given-up one still waits for the chat's next open, and gets no more tries.
- **A nudge that no longer exists is dropped.** A nudge the chat no longer has (you rewound past it,
  or it was cancelled) leaves Sova's list when the chat starts or rewinds. It costs at most one
  start.

## §chat.wake-nudges/kinds — Every kind of chat

- **Ordinary chats, the Overseer and project overseers** come back on their own, as above.
- **A worker** comes back only through the chat that owns it. Sova brings that main chat back, the
  main chat restarts the stopped worker under its recorded loadout, and only then is the nudge
  delivered.
- **A paused team** takes the same route: the main chat comes back, restarts a stopped monitor, and
  delivers the nudge to it (§teams.defaults/wake-nudge). A held team nudge stays held and brings
  nothing back.
- **Kept until delivered.** A due nudge is never dropped because its worker wasn't running. It stays
  pending until it has really reached the worker, with tries bounded as above
  (§chat.wake-nudges/tries).
