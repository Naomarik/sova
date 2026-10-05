# Wire goldens: what the browser's live path does with each event

Milestone 3 (§app/harness, the wire) ports the browser's live reducer (`src/lib/live.ts` `applyEvent`) from pi's
events to `SovaEvent`, and the server's frames to an opt-in v2. These goldens record, **before** the port
(W3.0), what today's code does, so W3.2 and W3.4 prove theirs identical. They run in `pnpm test`.

```
inputs/live-test.json        every store sequence src/lib/live.test.ts drives, as calls (extract-live.ts wrote it)
inputs/effects.json          hand-written event sequences for the effects the other inputs never reach
                             (the Overseer's navigate, compaction results, replies that measure nothing)
expected/faux/<scenario>/    frames.json: the v1 control frames for ../fixtures/faux/<scenario>/events.json
                             trace.json:  those frames through ChatView's unwrapping and applyEvent
expected/live/<seq>/trace.json, expected/effects/<seq>/trace.json
wire.ts                      control frames, the trace runner, the pre-W3.0 flush oracle
wire.test.ts                 inputs vs expected
live-calls.ts, extract-live.ts   the live.test.ts extraction
```

## What is recorded

- **Control frames** (faux streams): each pi event as the server sends it, the exact string a client receives:
  `JSON.stringify({type: "event", event: toWireEvent(ev), entryId?})`. A `message_end` carries `entryId` when
  the entry pi wrote at that moment holds the very message (`holdForEntryId`); the session file stands in for
  the leaf (the next message entry, in order, with an equal message). Compared byte for byte.
- **Traces**: one step per frame or call, on a fresh store: the `LiveState` after it (as JSON), and for
  `applyEvent` its effects (`src/lib/live-effects.ts`) with no view, plus `overseer` (the Overseer's view, in
  the tab that started the turn) only where they differ; a mutator's return value as `returned`. `new Date()`
  reads 2026-01-01T00:00:00Z while a trace runs (an aborted reply's `stoppedAt`).
- Every trace also checks, without recording it, that each `applyEvent`'s effects equal the inline decisions
  ChatView's flush made before W3.0 (`flushEffectsBeforeW30`, in both views), and that the view never changes
  the state.
- Comparison and storage are `../golden.ts`'s: by value, the first differing JSON path named; an output over
  256 KiB is stored as its digest (`image-resize`'s trace, which carries the image in every step).

## Commands

| | |
|---|---|
| `pnpm test -- server/harness/pi/golden/wire/wire.test.ts` | compare (also part of every `pnpm test`) |
| `SOVA_GOLDEN_MODE=record pnpm test -- server/harness/pi/golden/wire/wire.test.ts` | write the missing expected files |
| `SOVA_GOLDEN_MODE=record SOVA_GOLDEN_ACCEPT=trace pnpm test -- …` | rewrite differing `trace` files (`frames` likewise), after a `../CHANGES.md` line saying why |
| `bun server/harness/pi/golden/wire/extract-live.ts [--check]` | re-extract `inputs/live-test.json` from live.test.ts |

The inputs are the record. Since W3.2 rewrote live.test.ts (its events now go through `feed`, on three
paths), `extract-live.ts --check` differs; `inputs/live-test.json` stays as recorded.

## Since the port (W3.2)

`applyEvent` takes `SovaEvent`. Each recorded v1 event (a faux control frame, or a recorded input with its
`entryId` moved back onto the frame) runs on two paths, each on its own store and in both views: (b) the v1
frame as ChatView reads it (`liveEventsOf`, so `fromV1`), which is what the trace records, and (a) the wire-2
frames a server makes of it (`{type:"event", v:2, event}` per `fromV1` event, through JSON). Both must give
the recorded state and effects at every step, and the effects must still equal `flushEffectsBeforeW30` of the
v1 event. The baton sender marker is client-local and is applied as it is on both.
