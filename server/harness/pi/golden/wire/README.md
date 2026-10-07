# Wire goldens: what the browser's live path does with each event

Characterization tests for the live wire (§app.harness/wire): the frames the server sends for recorded pi
event streams, and what the browser's live reducer (`src/lib/live.ts` `applyEvent`) does with them. First
recorded before milestone 3 ported the reducer to `SovaEvent` (W3.0), they now pin the current behaviour.
They run in `pnpm test`. The live reducer's own cases are `src/lib/live.test.ts` and its effects
`src/lib/live-effects.test.ts`.

```
inputs/effects.json          hand-written event sequences for the effects the faux streams never reach
                             (the Overseer's navigate, compaction results, replies that measure nothing)
expected/faux/<scenario>/    frames.json: the v1 control frames for ../fixtures/faux/<scenario>/events.json
                             (the wire-1 contract: wire-compat, proxy-wire and share-ws-hop compare against it)
                             trace.json:  those frames through ChatView's unwrapping and applyEvent
expected/effects/<seq>/trace.json
wire.ts                      control frames, the trace runner
wire.test.ts                 inputs vs expected
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
- Every trace also checks, without recording it, that the view never changes the state.
- Comparison and storage are `../golden.ts`'s: by value, the first differing JSON path named; an output over
  256 KiB is stored as its digest (`image-resize`'s trace, which carries the image in every step).

## Commands

| | |
|---|---|
| `pnpm test -- server/harness/pi/golden/wire/wire.test.ts` | compare (also part of every `pnpm test`) |
| `SOVA_GOLDEN_MODE=record pnpm test -- server/harness/pi/golden/wire/wire.test.ts` | re-record: write missing files, rewrite differing traces; review the diff |

Recording never rewrites an existing `frames.json`: those are what older clients and peers read, so a
difference there is a protocol change to fix in the server, not a file to re-record.

## Since the port (W3.2)

`applyEvent` takes `SovaEvent`. Each recorded v1 event (a faux control frame, or a recorded input with its
`entryId` moved back onto the frame) runs on two paths, each on its own store and in both views: (b) the v1
frame as ChatView reads it (`liveEventsOf`, so `fromV1`), which is what the trace records, and (a) the wire-2
frames a server makes of it (`{type:"event", v:2, event}` per `fromV1` event, through JSON). Both must give
the recorded state and effects at every step. The baton sender marker is client-local and is applied as it is
on both.

## Wire 2 (W3.4)

`v2/faux/<scenario>/` pins what a consumer that asked for wire 2 gets, through the server's real paths
(`server/harness/pi/wire-compat.test.ts`, which also writes them): `frames.json`, each frame a `ChatSession`
client with `wire: 2` receives for the scenario's events (every control frame through `fromV1`, one frame per
event), and `rows.json`, that client's hello rows (`facts` in place of `meta`). The same test holds the wire-1
client to `expected/faux/<scenario>/frames.json` byte for byte, and checks that every wire-2 frame is `fromV1`
of its v1 frame over `inputs/effects.json` and every faux stream. Re-record the v2 files with
`SOVA_GOLDEN_MODE=record pnpm test -- server/harness/pi/wire-compat.test.ts` (it only reads the wire-1 files).

## The hops (W3.5)

`share/<set>/<fixture>/session-share-view.json` pins the frame a session share page's socket gets for each
committed fixture (`{type:"view", view}`, a live share titled "Golden share"; `null` where the share refuses the
file), written by `server/share-wire.integration.test.ts`. They were recorded on this branch and compare equal on the
server before wire 2 (`6088958a`, the tree W3.4 started from), so they are the share frames as they were. That
test also holds both share sockets and `/api/s` to no `event`, `meta` or `facts` key, and to the same bytes
whether or not the page asks for `wire=2`. The mesh hop is pinned without goldens of its own: in
`server/mesh/proxy-wire.test.ts` a stand-in peer answers per wire with `expected/faux/*/frames.json` or
`v2/faux/*/{frames,rows}.json`, and the browser behind `/peer/<id>/` must get them byte for byte with its
query unchanged; `server/share-ws-hop.test.ts` does the same for the gateway's `/ws/h` hop.
