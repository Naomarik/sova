# §app/provider-limits — Provider limits
> Part of the Sova design spec · [overview](../design/overview.md)

Each provider can have a limit on how many of its model requests run **at once on this device**,
set on Settings → Models (§app.provider-limits/setting). Work over the limit **waits** in a queue
instead of failing: a fan-out of fifty workers on a provider that allows five requests at a time
runs five requests at a time, and none of them reads the provider's 429.

The gate is a pi-config extension (`pi-config/extensions/provider-limits/`), so it holds in the
TUI, in every session Sova hosts and in every pi worker, whether Sova is running or not. Sova's own
one-shot calls go through the same gate module. Its state is plain files under the agent directory,
and every process on the device reads and writes them the same way.

## §app.provider-limits/file — The limits file

- The limits live in `<agent dir>/provider-limits.json`: `{"version": 1, "limits": {"zai": 5}}`.
  Each value is a whole number from 1 to 999. A provider the file doesn't name has no limit.
- With no file, the defaults apply: `zai` 5 and `ollama-cloud` 10. Every other provider, OpenAI
  Codex and Claude Code included, has no limit until one is set. A file that exists but can't be
  read as that shape also applies the defaults, and never blocks a request.
- The file is read at each request's claim, so a save applies to the next request anywhere on the
  device, a TUI's included, with no reload.
- Sova writes it atomically (temporary file, then rename), and never over a file it can't read.

## §app.provider-limits/in-flight — What holds a slot

- One model request holds one of its provider's slots from just before it is sent until its
  stream ends: done, error or abort. Tool execution between requests holds no slot, so a worker
  running a long test leaves the provider free for others.
- Slots are counted across every process on this device that loads the gate: TUI sessions, the
  sessions Sova hosts (the Overseer included), pi workers and team members (each is given the
  extension beside its worker mark), and Sova's own pi one-shots (decisions and session titles).
  Compaction, branch summaries and cache warms are requests of the session that makes them.
- For `claude-code`, a slot is one Claude Code model call of a chat session on the
  Claude Code provider, or one Claude Code one-shot of Sova's (a decision or a session title).
  Claude Code workers and the topic outline's Claude summarizer start the CLI themselves and are
  not counted.
- A request that already holds its provider's slot (a Sova one-shot passing through a runtime that
  also loads the extension) is not counted twice.

## §app.provider-limits/queue — Waiting and order

- A request that finds its provider full waits; it never fails for that.
- A session's own turn goes ahead of background work. Background is a pi worker or team member,
  the Overseer, and every request not made by a session a person drives: Sova's one-shots and an
  extension's own calls (a summarizer's). Within a class, first come, first served.
- Background work that has waited more than 2 minutes ranks as a session's turn, in the order it
  arrived, so a steady stream of interactive requests can't starve it.
- Stopping a turn while its request waits removes the request from the queue at once; the turn
  ends as an ordinary stop.
- A lower limit saved while requests run doesn't cut them off: they finish, and new requests wait
  until the count is under the new limit.

## §app.provider-limits/waiting-shown — Saying it waits

- While a session's request waits, its status says so in place of Working:
  `Waiting for zai · 5 of 5 in use` — the provider, the slots in use and the limit that applies.
  While the limit is lowered (§app.provider-limits/rate-limit) it adds `(lowered after a rate limit)`.
- In Sova the chat's status line shows it while that session's turn runs, in place of Working, and
  the session's row in the list gives it as its busy mark's `title` and accessible name, instead of
  "pi is replying in this session". A running worker waiting on its provider reads **Queued** in its
  row (§app.subagents-pane/worker-rows): a plain `.chip` with a dot, never pulsing, with the waiting
  text as the chip's `title`. The TUI shows the same text in its status bar, and clears it when
  the request is sent.
- Sova reads the waiting from the queue files, by session id (`GET /api/provider-limits/waiting`):
  the contract is the files, not an event, so a TUI's or a worker's wait shows the same way as a
  hosted session's. The web asks every 2 seconds while a view that could show a wait is on screen
  (a running chat, a busy row, a running worker) and not otherwise, so it can lag the queue by
  about that much. Only this host's queue is read.

## §app.provider-limits/rate-limit — A 429 from a limited provider

- A reply of 429 "rate limit" from a provider that has a limit, before any output, doesn't fail the
  turn: the request gives its slot back, waits a cooldown (the reply's `Retry-After` when the
  provider sends one, else 10 s) and queues again, at most 5 times. After the fifth, the error
  reaches pi as it would have, and pi's own retry runs as before. A 429 that says the quota or
  balance is exhausted is not retried here.
- A 429 also **lowers** that provider's limit for 5 minutes, to one below the limit the rejected
  request was sent under, never below 1. The lowering is shared by every process on the device
  (`<agent dir>/provider-limits/<provider>/lowered.json`, `{v, limit, until}`). Another 429 on a
  request sent under the lowered limit lowers it again and restarts the 5 minutes; when they run
  out, the limit is the Settings number again.
- The Settings value is never rewritten. While it lasts, the provider's row on Settings → Models
  adds `lowered to 4 until 3:12 PM` to its meta line and to the field's `title`, and the waiting
  text says why (§app.provider-limits/waiting-shown).

## §app.provider-limits/stale — A crash never blocks a provider

- Each process refreshes its slots and queue entries every 5 seconds. A slot or queue entry whose
  process has died, or that hasn't been refreshed for 30 seconds, is removed by the next process
  that reads the provider's files. A crashed or killed process never holds a provider for longer
  than that.

## §app.provider-limits/per-device — One count per device

- Limits are enforced per device. With the mesh on, the file syncs like the model policy (the same
  numbers everywhere, and a peer's copy is taken only if it is the file's exact shape), but slots,
  queues and a lowered limit are never shared between devices.

## §app.provider-limits/setting — The "At once" field

- Every provider group head on Settings → Models (§app.settings-dialog/models) has an **At once**
  number field after its switches: empty reads `No limit`, otherwise 1–999. Its accessible name is
  `Requests at once for zai`. `claude-code` has it too. A provider the file names that has no
  models on this machine is listed as well, with `No models on this machine`, so its limit can
  still be seen and cleared.
- Like the switches it is staged: the dialog's **Save Changes** writes it, **Discard Changes** puts
  it back. Save reads the file again first and applies only the providers whose field you changed,
  so a limit another device's sync wrote while the form was open is kept. A value outside 1–999
  or not a whole number keeps Save from writing and says why.
- A failed save keeps every field as you left it and says so in an error banner:
  **Couldn't save the request limits.** {reason}. "Your saved limits are unchanged." A file that
  can't be read is shown in an error banner and isn't overwritten.
