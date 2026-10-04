# Bun quirks

Sova's server runs on Node or Bun (see "Server runtime (Node or Bun)" in `CLAUDE.md`). This page lists
every place where Bun behaves differently from Node and Sova depends on the difference.

The rules:

- **One place.** A runtime workaround lives in `server/runtime-quirks.ts`. Call sites use its
  helpers and never mention a runtime. The workarounds probe for the broken behaviour; none of them
  reads `process.versions.bun`. (The launcher's runtime choice, `server/runtime-choice.ts`, and the
  canaries below are the only code that reads it.)
- **Fixed by design where possible.** When renaming a file or changing a test removes the
  dependency, no runtime code is involved.
- **Every quirk has a canary** in `server/bun-quirks-canary.test.ts`. It asserts that the bug
  still exists, runs only under Bun (`pnpm run test:bun`) and is skipped on Node. When a Bun
  upgrade fixes a bug, its canary fails. Then delete the workaround named below, the canary and
  this row.
- **Every quirk has a repro** in `bun-quirks/repros/`. It is standalone and ready to file
  upstream; none has been filed yet.

## The quirks

| Quirk | Bun | Upstream issue | Workaround | Canary | Repro |
|---|---|---|---|---|---|
| resolver-case | 1.4.2 | TBD | by design: no siblings that differ only by case (`src/vis/kinds/chart/Parts.tsx` → `PartsView.tsx`); `server/sibling-case.test.ts` keeps it so | `resolver-case` | `repros/resolver-case/` |
| homedir | 1.4.2 | TBD | `pnpm run test:bun` (`scripts/run-tests.mjs --runtime bun`) sets the throwaway HOME in the environment before bun starts; `hermetic-env.mjs` refuses to run when `os.homedir()` doesn't follow it | `homedir` | `repros/homedir.mjs` |
| ws-max-payload | 1.4.2 | TBD | `cappedWebSocketServer` / `cappedWebSocket` / `enforceMaxPayload` in `server/runtime-quirks.ts`, used by every WebSocket in `server/` | `ws-max-payload` | `repros/ws-max-payload.mjs` |
| ws-socket | 1.4.2 | TBD | by design: `server/compression.test.ts` counts bytes through a TCP relay instead of `ws._socket.bytesRead` | `ws-socket` | `repros/ws-socket.mjs` |
| ws-deflate | 1.4.2 | TBD | none: remote sockets go uncompressed (local browsers never get deflate anyway); `wsNegotiatesDeflate` in `server/runtime-quirks.ts` tells `server/compression.test.ts` which behaviour to assert | `ws-deflate` | `repros/ws-deflate.mjs` |
| fetch-refused | 1.4.2 | TBD | `connectionRefused` / `errorCode` in `server/runtime-quirks.ts` (classify by code: `ECONNREFUSED` or `ConnectionRefused`, own or cause's), used by `server/extensions.ts` | `fetch-refused` | `repros/fetch-refused-error.mjs` |
| assert-throws-empty | 1.4.2 | TBD | test-only: `server/mesh/address-identity.test.ts` doesn't pass `""` as the message | `assert-throws-empty` | `repros/assert-throws-empty-message.mjs` |
| ws-handshake-timeout | 1.4.2 | TBD | `cappedWebSocket` in `server/runtime-quirks.ts`: its own timer, 50 ms after ws's, emits ws's error and terminates the socket | `ws-handshake-timeout` | `repros/ws-handshake-timeout.mjs` |
| fetch-read-size | 1.4.2 | TBD (and pi-ai upstream) | `useSlicedProviderReads` / `slicingFetch` in `server/runtime-quirks.ts`, installed once in `server/chat-manager.ts` (skips google-* adapters, which refuse a custom fetch) | `fetch-read-size` | `repros/pi-ai-runaway-tool-call.mjs` |
| event-loop-delay | 1.4.2 | TBD | `loopDelaySampler` in `server/runtime-quirks.ts` (used by `server/resource-monitor.ts`) | `event-loop-delay` | `repros/event-loop-delay.mjs` |

### resolver-case

`import "./parts"` in a folder that holds both `parts.ts` and `Parts.tsx` fails with
`ENOENT reading ".../parts.tsx"`. Bun matches the name case-insensitively and then reads the
file under the import's case, which doesn't exist on a case-sensitive file system. Node with tsx
loads `parts.ts`. Sova's fix is a rename. The repo test `server/sibling-case.test.ts` fails when
any two module files or directories in one folder under `src/`, `server/`, `shared/` or
`pi-config/extensions/` differ only by case once the extension is dropped. Stylesheets and other
assets are exempt, because they are always imported with their extension.

### homedir

`os.homedir()` ignores a change to `process.env.HOME` made after the process started; Node
follows it. The test preload `pi-config/extensions/claude-code/tests/hermetic-env.mjs` points HOME
at a throwaway directory in-process, so under Bun the tests would resolve the real `~/.pi`.
`pnpm run test:bun` creates the throwaway home and puts HOME, `USERPROFILE` and `SOVA_TEST_HOME` in
bun's environment. It also clears `PI_CODING_AGENT_DIR`, `CLAUDE_CONFIG_DIR`, the XDG dirs and the
other variables the preload clears. The preload keeps that home. If `os.homedir()` still
disagrees, it throws before any test runs, on any runtime. Never run a Bun test any other way.
Never rely on setting HOME in-process in code meant to run on Bun.

### ws-max-payload

Bun replaces the `ws` package with its own shim, which ignores `maxPayload`. On Node, a message
over the cap closes the socket with 1009. On Bun, the listener gets the whole message. Sova's
public share sockets depend on the 1 KB cap (§app.baton/share-listener,
§app.session-share/presence, §mesh.public/routing). Every WebSocket in `server/` is therefore
built through `cappedWebSocketServer` or `cappedWebSocket`. Each accepted or dialed socket then
checks the cap itself: the first message over it closes with 1009 (or calls the caller's
`onOversize`; a share hop ends as "lost"). No listener sees that message or any after it. The
default cap is ws's own, 100 MiB. This check needs no probe and runs on both runtimes. Where ws
enforces the cap first, as on Node, it never fires. A new WebSocket in `server/` must use these
factories, or its cap holds on Node only.

### ws-socket

A `ws` WebSocket has no `_socket` under Bun. This is a private field of the ws package. Sova's
runtime code doesn't read it. One test read `_socket.bytesRead` to compare compressed and plain
transfers. It now counts the bytes that cross a small TCP relay.

### ws-deflate

A ws server under Bun never negotiates permessage-deflate, whatever its `perMessageDeflate`
options, and whether the client is Bun's or Node's ws. The data is still correct. **The cost:** on
a Bun server, `/ws/chat` and `/ws/watch` send to remote clients uncompressed. That covers a phone
over the tailnet, anything behind a proxy and mesh peers. A session's whole-transcript snapshot is
then several times larger on the wire. A browser on the server's own machine is unaffected: it is
never offered deflate anyway (`isDirectLocal` in `server/compression.ts`, used by `server/ws.ts`).
There is no workaround, because Sova can't compress below the shim. `wsNegotiatesDeflate()`
(`server/runtime-quirks.ts`) probes whether a ws server here can negotiate it.
`server/compression.test.ts` asserts each runtime's behaviour: compressed where the probe says
yes; where it says no, the offer is declined and the snapshot still arrives whole, uncompressed.

### ws-handshake-timeout

A ws client's `handshakeTimeout` never fires on Bun. When a peer accepts the TCP connection and
never answers the upgrade, the socket stays connecting forever. A mesh hop to a wedged peer then
never answers 502, and neither does an extension's WebSocket proxy. `cappedWebSocket` arms its
own timer 50 ms after ws's, so on Node ws's timer always fires first. If the handshake has no
answer yet (open, upgrade or unexpected-response) when it fires, it emits ws's own error
("Opening handshake has timed out") and terminates the socket. Bun's terminate reports extra
errors and a second close, so after the timeout the factory passes on only its own error and one
close. bench reported that Bun's client never emits `unexpected-response`. In my probe, a peer
that answered the upgrade with a 503 did get `unexpected-response` (503) on Bun, followed by
close 1002, so the timer treats it as an answer.

### fetch-refused

A refused fetch shows up differently on the two runtimes. On Node (undici) it is a `TypeError`
"fetch failed" whose `cause.code` is `ECONNREFUSED`. On Bun it carries `code: "ConnectionRefused"`
on the error itself, with no cause and different wording. The extensions health check names a
refused backend "connection refused". It read Node's shape only, so on Bun the card said
"ConnectionRefused" instead. `connectionRefused(err)` and `errorCode(err)` classify the error by
its code, its own or its cause's, never by its message.

### assert-throws-empty

`assert.throws(fn, "")` passes on Node when `fn` throws: the string is the failure message. Bun
rejects it with `ERR_INVALID_ARG_VALUE` ("may not be an empty object"). This affects tests only.
The one test that did this (address-identity) is rewritten not to.

### fetch-read-size

Bun's fetch hands a streamed response body over in reads of 128–256 KiB; Node's are 64 KiB. That
is not a bug in itself. It met two pi-ai behaviours (upstream, not Bun):
- every SSE event of a read in hand is processed before the abort signal is consulted again;
- each tool-call delta re-parses the whole accumulated argument string (O(n) per delta).

When the stream guard (§chat.transcript/runaway-stream) stopped a runaway tool call at 8 KiB of
whitespace, Bun went on parsing ~670 more deltas where Node parsed ~75. The guarded turn took
~450 ms on Bun against ~95 ms on Node, all of it with the event loop blocked. The workaround is
`slicingFetch`, installed once per hosted session by `useSlicedProviderReads(session.agent)`
(`server/chat-manager.ts`). It re-slices every provider response body to reads of at most 64 KiB,
Node's own size, so nothing changes on Node. It passes every byte through unchanged (a UTF-8
sequence may be split at a slice edge, as at any read edge) and refuses the next read once the
request was aborted. A request that already names a fetch goes through unchanged, as does one to
a google-* adapter (pi-ai's Google adapters throw on a custom fetch). With it, the guarded turn on
Bun is back under the 250 ms bound. `repros/pi-ai-runaway-tool-call.mjs` is the repro for pi-ai
upstream, and it shows both behaviours on either runtime.

### event-loop-delay

`perf_hooks.monitorEventLoopDelay` on Node records each timer interval: the resolution plus the
lateness. Bun's records only the lateness. The resource monitor subtracts the resolution, as
Node's documentation implies, so on Bun every reading came out 0. `loopDelaySampler(resolution)`
runs a one-time probe of about 60 ms: does a 10 ms histogram's median include the interval? Where
it does, the sampler uses the histogram. Elsewhere it uses a timer-drift sampler that records each
interval in Node's form. Until the probe answers, the drift sampler is used, so the first readings
are never empty.

## Other differences (no workaround in runtime code)

These differ between the runtimes but need nothing in `server/runtime-quirks.ts`. They have no
canary because they are test-harness or tooling facts, not bugs Sova works around.

- **NODE_TEST_CONTEXT is unset under `bun test`.** `server/model-prices.ts` turns its price
  refresh off when it sees Node's runner. Under `bun test` it would fetch models.dev, and the mesh
  tests' "no outbound request" checks would fail. `test:bun` sets `SOVA_PRICES_FETCH=off`.
- **Loader hooks:** `module.register` and `module.registerHooks` don't apply under Bun. Tests that
  install a loader hook need another seam.
- **`mock.method` on `fs` with `syncBuiltinESMExports`:** the mock doesn't reach ESM importers of
  `node:fs` under Bun. Tests that mock fs that way need a seam instead.
- **`bun test` sets TZ=UTC and NODE_ENV=test.** node --test keeps the host's time zone and sets
  neither. A test whose result depends on the local time of day can pass on one runtime and fail on
  the other; project-overseer's per-day counts did, near midnight.
- **mise tool paths:** tests that spawn `python3` or `node` need mise's tool directories on PATH. A
  shim refuses an untrusted config in a throwaway HOME. The runner puts the real node's directory
  and `mise bin-paths` first.
- **Per-test timeout:** `bun test` defaults to 5 s per test; node:test has no default.
  `test:bun` passes `--timeout=60000`.
- **One process per file:** without `--parallel`, `bun test` runs every file in one process with
  shared globals. `test:bun` runs one `bun test <file>` per file, each with its own throwaway
  home, as `node --test` isolates files.
- **mise shims in a throwaway HOME:** a shim refuses an untrusted config there, so tests that spawn
  `node` would fail. `test:bun` puts the real node's directory first on PATH.
- **Workers and tools stay on Node.** A pi worker a Bun server spawns runs the global `pi`, a Node
  install, which may be a different version from the pinned one (0.87.0 vs 0.87.1 at the time of
  writing). The spec tools, including census, always run on node. Only the server process
  changes runtime.

## Running on Bun

- `pnpm run test:bun` (`node scripts/run-tests.mjs --runtime bun`) runs the unit suite under Bun.
  `pnpm test` (`--runtime node`) runs it under Node, and `.sova/project.json`'s `test.run` calls
  the same runner. Both run the same files in two passes: the main set, then `*.browser.test.ts`
  under `--conditions=browser`. A named file is routed to its pass. On Bun, each file runs in its
  own `bun test` process with its own throwaway home and `--timeout=60000`, half the cores at once
  (`TEST_BUN_JOBS=<n>` sets the width). Arguments that start with `-` go to the runner. Wrap it in
  `node scripts/test-sentinel.mjs -- …` to prove it touched nothing real.
- To run the server on Bun, see README's "Run on Node or Bun" and the "Server runtime (Node or
  Bun)" section of `CLAUDE.md`.
