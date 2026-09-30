# sova-whatsapp IPC, version 1

The contract between the WhatsApp sender (`services/whatsapp`, `sova-whatsapp run`) and its clients:
Sova's WhatsApp adapter on the same host, and the gateway relay, which carries the same frames for
other hosts. `scripts/fake-whatsapp-sender.mjs` speaks it too, with the sender's own state machine.

## Transport

- A Unix socket at `$SOVA_WA_SOCKET`, else `$SOVA_WA_HOME/sender.sock`; `SOVA_WA_HOME` defaults to
  `<PI_CODING_AGENT_DIR or ~/.pi/agent>/sova/whatsapp`. The socket is `0600` in a `0700` directory.
  The sender never listens on a network.
- One sender per home: it holds `$SOVA_WA_HOME/sender.lock` (its pid, created exclusively) while it
  runs. A second start refuses while that pid lives; a dead holder's lock is taken over.
- NDJSON both ways: one JSON object per line, UTF-8, `\n`-terminated, at most 64 KiB per line. A line
  that is not a JSON object gets `{id: null, ok: false, code: "bad-request"}`; an over-long line closes
  the connection.
- Any number of connections. Requests on one connection may be pipelined; each response carries the
  request's `id` (any JSON string or number the client picks). Responses may come out of order.

## Requests and responses

Every request is `{id, op, ...}`. Every response is `{id, ok: true, ...}` or
`{id, ok: false, code, retryable, why}`; `why` is one plain sentence for a person, `code` is for code.
An unknown `op` is `code: "bad-request"`.

### `hello {v: 1, since?: seq}`

Optional. It subscribes this connection to events (a connection that never says hello gets none),
then replays every kept event with `seq > since` (all kept events when `since` is absent), then goes live.

→ `{v: 1, version, state, seq, paused, authDir, gap?: true}`

- `version`: the sender package version. `seq`: the newest event's number (0 before any).
- `gap: true`: `since` is older than the kept ring (the last 500 events), so some were lost.
- `v` other than 1 → `code: "version"`.
- `authDir` is the resolved auth directory, so Sova can protect it (it is a path, never content).
  The relay drops it before forwarding.

`seq` is persisted, so it keeps increasing across sender restarts.

### `status {}`

→ `{state, why?, retryAt?, paused, me?, limits, usage, reconnects, version}`

- `state`: one of the states below. `why`: a sentence for every state but `open`.
- `retryAt`: ISO time of the next automatic reconnect, when `connecting` waits on the backoff.
- `me`: the linked number's last 3 digits as `"…123"`, when known. Never the full number.
- `limits`: `{gapS, perHour, perDay}`; `usage`: `{hour, day}` sends counted against them.
- `reconnects`: `{hour, day, perHour, perDay}`: automatic reconnects used and allowed.

### `check {digits}`

→ `{exists: boolean}`. Asks WhatsApp whether the number has an account (cached in memory for 24 h,
never on disk). Errors: `invalid`, `unpaired`, `not-connected`, and the state codes below.

### `send {idem, digits, text}`

Sends one text message. → `{ref, at, dup?: true}`

- `digits`: E.164 without `+`, `/^\d{7,15}$/`. `text`: 1 to 4096 characters.
- `ref`: an opaque id for this message, repeated in its receipt events. `at`: ISO time it was sent.
- `idem`: a string the caller namespaces itself (`local:<key>`, the relay `<StableID>:<key>`).
  The same `idem` within 24 h never sends twice: it returns the recorded result again with `dup: true`
  (ok or not); while the first is still in flight, the second gets the first's result when it settles.
  A send the sender cannot account for (it stopped between handing the message to WhatsApp and
  recording the outcome) answers `unknown` from then on, never a second send.
- It waits up to `SOVA_WA_SEND_WAIT_S` (15 s) for `open` before `not-connected`.
- The gap between sends (3 s by default) is kept by queueing, not by refusing.

Error codes:

| code | retryable | meaning |
|---|---|---|
| `invalid` | no | bad `digits`, `text` or `idem` |
| `unpaired` | no | no linked device yet |
| `not-connected` | yes | not `open` within the wait; nothing was sent (retryable `false` when the sender is `down`) |
| `not-on-whatsapp` | no | the number has no WhatsApp account |
| `logged-out` | no | the phone unlinked this device |
| `replaced` | no | another process opened these creds |
| `blocked` | no | WhatsApp refused the account (403); sending is paused |
| `restricted` | no | WhatsApp restricted new chats (463); sending is paused |
| `paused` | no | the pause switch is on |
| `limited` | yes | per-hour or per-day limit reached; `retryAt` says when a slot frees |
| `failed` | no | WhatsApp or Baileys failed the send |
| `unknown` | no | the outcome of that idem is unknown; it is never resent |

### Operator-only ops: the sender host only

`pause`, `link`, `reconnect` and `unlink` act on the number itself, so only someone on the sender's
host uses them: `sova-whatsapp pause | resume | pair | reconnect | unlink` on its socket (and Sova's own
page there never sends them either). The sender cannot tell a relayed request from a local one, since
the relay is a local client too, so the guarantee is the relay's: it forwards exactly `status`, `check`,
`send` and `events`, each rebuilt from named fields (never a caller's frame passed through), and
answers every other op with 403 `code: "refused"`. Keep it that way: an op added to the relay's
allowlist becomes callable by every accepted peer. Nothing else reaches the socket from off the host:
it is a Unix socket, `0600`, and the sender never listens on a network.

- `pause {on: boolean}` → `{paused}`. Persisted. While paused, `send` answers `paused`; the connection
  stays up. The sender also sets it on its own when WhatsApp blocks or restricts the account.

- `link {phone?}` → `{started: true, pairingCode?}`. Starts linking a device on an unpaired sender:
  `qr` events follow (scan within about a minute; WhatsApp refreshes it about five times, then stops).
  With `phone` (digits), a pairing code is returned instead to type on the phone. Refused with
  `code: "linked"` when already paired, `busy` while linking.
- `reconnect {}` → `{state}`. One immediate connection attempt from `down`, `replaced`, `blocked` or a
  backoff wait, outside the reconnect budget. Refused (`code: "needs-link"`) in `unpaired` and
  `logged-out`, and `code: "open"` when already open. Leaves `paused` as it is.
- `unlink {confirm: true}` → `{state: "unpaired"}`. Logs this device out on WhatsApp when connected,
  then deletes the auth directory's contents. Without `confirm: true`, `code: "bad-request"`.

## Events

`{ev, seq, at, ...}`, sent to connections that said `hello`. The last 500 are kept (on disk) for replay.

- `state {state, why?, retryAt?, paused}`: on every state or pause change.
- `receipt {ref, idem, status, code?}`: `status` is `delivered`, `read` or `failed` (then `code` is the
  WhatsApp error number as a string, e.g. `"463"`). `idem` lets the relay pass each caller only its own.
- `qr {qr}`: while linking only. Never replayed and never stored.
- `paired {me}`: linking finished (`me` masked as in `status`). Never replayed.

## What never crosses the socket or reaches a log

No frame carries a credential, and none but `send`/`check` requests carries a full number. The sender's
own files (`state.json`, `events.json`) hold no number and no message body; its log masks digit runs to
the last three. Its dependencies' `console` output is dropped (libsignal prints whole sessions, ratchet
private keys included; see `src/quiet-console.mjs`), so a client never needs to filter what it relays.

## States

| state | meaning | leaves by |
|---|---|---|
| `unpaired` | no linked device in the auth dir | `link` |
| `linking` | a `link` is waiting for the phone | the phone scans / types the code, or it times out |
| `connecting` | opening, or waiting `retryAt` to reconnect after a transient close | `open`, or a failure below |
| `open` | connected; sends go | a close |
| `logged-out` | the phone unlinked the device (401); creds kept, nothing automatic | `unlink`, then `link` |
| `replaced` | another process took the creds (440) | stop the other copy, then `reconnect` |
| `blocked` | 403 on connect, or 463 on a send; sending paused | wait, then `reconnect` and `pause {on:false}` |
| `down` | reconnect budget spent, 500, or a local error | `reconnect` |

## The fake sender

`node scripts/fake-whatsapp-sender.mjs [--unpaired]` resolves the same socket path (so with
`PI_CODING_AGENT_DIR=<worktree>/.agent` it listens at `<worktree>/.agent/sova/whatsapp/sender.sock`)
and runs the real state machine with a fake WhatsApp. It never loads Baileys. Every number exists but
those in `SOVA_WA_FAKE_ABSENT` (comma-separated digits); receipts follow `SOVA_WA_FAKE_RECEIPTS`
(`delivered,read` by default, or `delivered`, or `none`). It adds one op, `fake`, which the real sender
does not have:

- `{op: "fake", do: "close", code}`: the connection closes with that code (401, 440, 403, 500, 428, 515 …).
- `{op: "fake", do: "ack-error", code}`: the next send is failed by WhatsApp with that code (463, 479).
- `{op: "fake", do: "send-throw"}`: the next send throws inside the socket.

`node scripts/fake-whatsapp-sender.mjs ctl <close|ack-error|send-throw> [code]` sends that op.
