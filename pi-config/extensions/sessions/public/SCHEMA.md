# pi live-session records — public contract

This document is for **external consumers** (status bars, dashboards, webapps,
scripts) that want to show what running pi sessions on this machine are doing.
Machine-readable schemas are next to this file:

- `live-record.schema.json` — one live file (`$id: pi-sessions:live-record:2`)
- `feed.schema.json` — one NDJSON line from `pi-sessions watch` (`$id: pi-sessions:feed-event:1`)
- `examples/v2.json` (full v2), `examples/v1.json` (legacy writer with presence),
  `examples/legacy.json` (legacy writer, metadata only)

The reference reader is `schema.ts` + `feed.ts` in this extension. Both run
directly on `node` ≥ 23.6 with no dependencies, and you can import them.

## 1. Location and write protocol

```
~/.pi/agent/sessions/live/<id>.json        directory mode 0700
```

The directory is `<agent dir>/sessions/live`, where the agent dir is pi's own:
`$PI_CODING_AGENT_DIR` when set (a leading `~` expanded, as pi's `getAgentDir()`
does), else `~/.pi/agent`. A writer and its readers must agree on it: Sova's
server resolves it through pi's `getAgentDir()`.

- `<id>` is `p<pid>-<8 hex>`, for example `p48213-3fa9c2d1`. The file stem **is** the
  identity: ignore any file whose `session.id` doesn't match its stem.
- Each pi process owns exactly one file. It writes the whole record to a
  dotfile temp (`.<id>.<pid>.tmp`) and then `rename(2)`s it over `<id>.json`.
  Readers never see a partial record. Skip dotfiles and any name that doesn't
  end in `.json`.
- The writer rewrites its file right away on any change, and otherwise as a
  heartbeat: at least **3 s** apart, checked on a 2 s poll, so roughly every
  3–4 s. A clean shutdown deletes the file.
- Treat each file as untrusted input. Parse defensively, and skip any file that
  fails to parse or validate. Don't treat a bad file as a fatal error.

## 2. Liveness

| condition | meaning |
|---|---|
| `now - heartbeat ≤ 15 000 ms` **and** `session.pid` alive | **fresh**: show it |
| `now - heartbeat > 15 000 ms`, pid alive | **stale**: hide it (event loop may be busy; it can come back) |
| pid dead (`kill(pid, 0)` ⇒ `ESRCH`) | **dead**: gone; pi writers delete the file |
| `now - heartbeat > 90 000 ms` | pi writers delete the file |

`EPERM` from `kill(pid, 0)` means the process is alive. Only pi writers delete
files. Consumers must never delete, create, or modify anything in this directory.

> **Raw fs watchers:** `inotify`, `fs.watch`, `chokidar` and similar tools fire
> an event on **every 3 s heartbeat rewrite**, even when nothing changed.
> Use `pi-sessions watch` instead (see §8). It diffs the content, drops
> heartbeat-only and `note`-only rewrites, and handles staleness for you. If
> you do read the directory yourself, compare records with `lastActivity`,
> `heartbeat` and `note` left out (see `hashRecord` in `feed.ts`).

## 3. Record shape

```jsonc
{
  "v": 1,                 // REQUIRED, frozen forever
  "schemaVersion": 2,     // optional; absent ⇒ legacy (v1) writer
  "session":  { … },      // REQUIRED  SessionMeta
  "presence": { … },      // optional  Presence (absent ⇒ metadata-only)
  "note":     { … },      // pi-internal — IGNORE
  "heartbeat": 1789804797000   // REQUIRED ms epoch of last write
}
```

Limits are maximum lengths in characters (arrays: maximum items). Writers
enforce them, and the reference reader enforces them again.

### session (SessionMeta)

| field | req | type | limit | notes |
|---|---|---|---|---|
| `id` | ✔ | string | 128 | equals the file stem |
| `cwd` | ✔ | string | 300 | |
| `model` | ✔ | string | 160 | |
| `pid` | ✔ | int > 0 | | |
| `startedAt` | ✔ | ms epoch | | |
| `lastActivity` | ✔ | ms epoch | | time of the last write (changes on every heartbeat) |
| `endpointEpoch` | | string | 64 | changes when the process re-registers |
| `name` | | string | 80 | |
| `status` | | string | 100 | v1 free-text label, same as `presence.status` |
| `sessionId` | | string | 64 | pi session UUID (v2) |
| `sessionFile` | | string | 1024 | absolute transcript path, never its contents (v2) |
| `mode` | | `tui`\|`rpc`\|`json`\|`print` | | (v2) |
| `host` | | string | 64 | `os.hostname()` (v2) |
| `piVersion` | | string | 32 | (v2) |

### presence

| field | req | type | limit | notes |
|---|---|---|---|---|
| `type` | ✔ | `"presence"` | | |
| `version` | ✔ | `1` | | frozen |
| `status` | ✔ | string | 100 | v1 label: `Idle`, `Running`, `Running: bash, read`, `Needs input`, `Error` |
| `since` | ✔ | ms epoch | | time the status last changed |
| `completed` | ✔ | ms epoch | | last settled run or worker completion (0 if none yet) |
| `preview` | ✔ | string | 2000 | latest assistant text |
| `workers` | ✔ | WorkerEntry[] | 40 | |
| `target` | | FocusTarget | | **opaque**, see §7 |
| `outline` | | Outline | | topic-outline enrichment |
| `activity` | | Activity | | (v2) structured state; prefer it over `status` |
| `workerCounts` | | WorkerCounts | | (v2) tally of all workers, including any dropped for size |
| `workerUsage` | | WorkerUsageTotal | | (v2) lifetime token Σ across every worker the session ever ran |
| `focusable` | | boolean | | (v2) |
| `focusReason` | | string | 120 | (v2) why focusing is or isn't possible |
| `previewAt` | | ms epoch | | (v2) time `preview` was produced |

**WorkerEntry**: `id` ✔ (150), `name` ✔ (120), `status` ✔ (80, free text),
`model` (100), `preview` (180), `backend` (32, v2), `sessionFile` (1024, v2, optional),
`sessionId` (64, v2, optional), `effort` (32, v2, optional), `startedAt`/`lastActivity`/`endedAt`
(ms epoch, v2), `outcome` (`success`|`error`|`aborted`, v2), `usage` (WorkerUsage, v2),
and, for a restored worker (v2, all optional): `restored` (`true`), `usageSource`
(`transcript`|`snapshot`|`none`), `usageAsOf` (ms epoch), `interruptedAt` (ms epoch),
`resumable` (boolean).
`sessionFile` is the absolute path of that worker's own transcript JSONL, never its
contents (same rule as `session.sessionFile`); consumers may read it but must never
write to it. `sessionId` is the worker's backend session id (for `claude-code`
workers, the Claude session id; those have no `sessionFile`). Both are additive:
empty or over-limit values are dropped rather than truncated, and a reader that
ignores them behaves exactly as before.
`effort` is the thinking/effort level the worker was spawned with (`pi`: the explicit
level, else the parent's at spawn, then the child's own reported one; `claude-code`:
the resolved effort, `medium` by default). It is free text, not an enum, since the
levels are backend-specific. Same rule: empty or over-limit ⇒ dropped, never truncated;
absent means the writer didn't publish one (records written before it existed).
A **restored** worker was rebuilt after a restart from the owner session's durable
worker record; no process runs for it. Its status is `restored` while it was alive
at the restart (`interruptedAt` set when it died mid-turn), or its recorded ending
(`done|error|killed`) with `restored: true` when it had already ended. `usageSource`
says where its `usage` came from: its own transcript, the last snapshot the manager
recorded (as of `usageAsOf`), or `none`, meaning unavailable, which must never be
shown as 0. `resumable` is true when its owner can bring it back (idle) on demand.
Worker status is normalized to `starting|running|waiting|stopping|done|error|killed|restored`,
and common aliases map onto those (`busy` ⇒ running, `completed` ⇒ done, …).
**Unknown ⇒ `running`**. `waiting` means steerable/idle. It does not mean the worker succeeded.

**WorkerCounts**: `total`, `working` (starting+running+stopping+unknown),
`waiting`, `done`, `error`, `killed`. All are required non-negative integers.
A `restored` worker counts in `total` only: it is never working (it has no process).

**WorkerUsage** (v2): `input`, `output`, `cacheRead`, `cacheWrite` (required
non-negative integers, cumulative for that worker) and `cost` (USD, only when the
backend reports one). Counts only — a record never carries worker text beyond the
bounded `preview`. Individual bad values read as 0 rather than dropping the worker.

**WorkerUsageTotal** (v2, `presence.workerUsage`): the same fields plus `workers`,
optional `asOf` (ms epoch: the oldest snapshot time among the parts of the Σ that
came from a snapshot, since the Σ is only true as of its stalest part) and optional `restored` (how many workers in the Σ are restored),
and it is a **session-lifetime Σ**: it covers every worker the session ever spawned,
including ones dropped by the writer's 40-row cap, by the manager's retention cap, or
by `fit()`. So `workerUsage.workers` may exceed both `workers.length` and
`workerCounts.total`, and the Σ is generally larger than the sum of the rows present.
Do not recompute it from `workers[]`; a consumer wanting "the rows I can see" should
sum `workers[].usage` itself.

**Outline**: `now` (160), `overall` (300), `topics` (12 × 60), `lastHeading` (80),
`state` (`none|drafting|fresh|updating|stale|failed-keeping-last`), `generatedAt`,
`detail` (6 × `{heading (80), bullets: 3 × 120}`).

**Activity** (v2): `state` ✔ (`working|idle|needs-input|error`), `since` ✔,
`tools` (6 × 40, tools running right now), `toolDetail` (60, e.g. `"edit · auth.ts"`),
`error` (200, only present when `state` is `error`), `lastAssistantAt`, `lastToolAt`,
`lastPromptAt`, `turns` (settled runs), `buckets` (16 ints, tool executions per
bucket, oldest first), `bucketMs` (usually 15000).

### Deriving a session state

Use `presence.activity.state` if it exists. Otherwise map the legacy label
(`presence.status`, falling back to `session.status`):
`/^Running/` ⇒ `working`, `"Needs input"` ⇒ `needs-input`, `/^Error|error/` ⇒ `error`,
anything else ⇒ `idle`. Treat a record with no `presence` as metadata-only
("basic"). You know it's alive, but not what it's doing.

## 4. Versioning rules

- `v` stays `1` permanently, so v1 readers keep working.
- `schemaVersion` changes **only for a breaking change to a required field**.
  Additive changes (new optional fields, new enum values) never change it.
  A reader must reject a record whose `schemaVersion` is newer than the one it supports.
- Ignore keys you don't recognize, at every level.
- Map unknown enum values to safe defaults instead of rejecting them. For
  session state that's `idle`; for worker state it's `running`. For optional
  enums like `outline.state`, `session.mode` and `worker.outcome`, treat the
  field as absent. An enum value you don't recognize never invalidates the record.
- A malformed optional block (e.g. a `presence` missing a required field) is
  dropped by itself. The session stays listed with metadata only.
- A heartbeat more than 5 minutes in the future is treated as garbage.

## 5. Size budget

Each record is at most **16 384 bytes** of UTF-8 JSON. Per-field limits are
applied first. If the record is still over budget, the writer drops content in
this order:

1. `presence.outline.detail`
2. `presence.activity.buckets`
3. `presence.preview` truncated to 600 characters
4. `presence.outline.overall` and `presence.outline.topics`
5. `presence.workers[].usage`: every row's own counts, all at once
6. `presence.workers`: finished (`done|error|killed`) and `restored` ones go first regardless
   of position, then entries are removed from the end

`workerCounts` and `workerUsage` still reflect every worker, so
`workerCounts.total` and `workerUsage.workers` can be larger than
`workers.length` and the Σ larger than the rows that survived.

## 6. Privacy

Records **never** contain user prompts, thinking blocks, full tool output,
bash commands or arguments, or session transcript contents. Only the path is
included (`session.sessionFile`, and a worker's own `sessionFile`).

- Assistant text is capped: `preview` ≤ 2000 characters, `activity.error` ≤ 200.
- `activity.toolDetail` holds a tool name plus a file **basename** only.
- Outline text is an LLM paraphrase, except `outline.lastHeading`, which can be
  the latest `#` heading the user typed (≤ 80 characters). topic-outline's own
  sharing settings (`shareWithSessions`, `shareLastHeading`) control all of it.
- All text has terminal control sequences (OSC, CSI, C0/C1) stripped. Still,
  escape it for whatever you render into (HTML, a shell, and so on).
- The directory is mode 0700 and readable only by the owning user. Don't copy
  records anywhere more widely readable without the user's consent.

## 7. `note` and `target` — hands off

- **`note`** carries pi-internal transient control messages between sessions.
  Its shape isn't part of this contract, and consumers **must ignore** it.
  A change to `note` alone is never a meaningful update.
- **`target`** is a pi-internal focus identity (Hyprland/Ghostty/tmux process
  identities plus a window address). External tools must **NEVER** call
  `hyprctl dispatch focuswindow address:…` (or anything similar) using
  `target.address` directly. The address can be reused by another window, and
  the record can be stale. Use **`pi-sessions focus <id>`** only. It re-reads
  the record and re-validates the whole identity (compositor instance, boot ID,
  process start times, TTYs, and the visible title) before it focuses anything.

## 8. The `pi-sessions` CLI and feed events

A standalone node script in `bin/pi-sessions.ts`. It doesn't need pi installed
(node ≥ 23.6 or bun), and it never writes to the live directory:

| command | purpose |
|---|---|
| `pi-sessions snapshot [--include-stale]` | print one `snapshot` event (JSON). Fresh sessions only unless `--include-stale`. `--json` is accepted and changes nothing |
| `pi-sessions watch [--heartbeats] [--snapshot-every <dur>]` | NDJSON stream: `hello`, `snapshot`, then `upsert` / `remove` / `error` as things change |
| `pi-sessions focus <id-or-name>` | validate the identity and focus that session's terminal window |
| `pi-sessions menu [--format dmenu\|json]` | launcher lines `<label>\t<id>` (default `dmenu`), or one JSON array of `LiveSession` |
| `pi-sessions serve` | *deferred*: local HTTP/SSE bridge for webapps |

Every command accepts `--dir <path>` (default: `$PI_SESSIONS_DIR`, else
`$PI_CODING_AGENT_DIR/sessions/live`, else `~/.pi/agent/sessions/live`). Exit codes: `0` ok, `1` runtime or record error
(focus refused, for example), `2` usage error, with the usage text on stderr.
Sessions in `snapshot`, `menu` and the watch snapshots are sorted
needs-input/error first, then working (most recent first), then the rest by
name, with stale sessions last.

- `watch --snapshot-every 30s` re-emits a full `snapshot` periodically
  (`ms`, `s`, `m` or bare milliseconds; `0` disables, the default). Replace your
  whole state on every `snapshot`.
- `watch --heartbeats` also emits an `upsert` for heartbeat-only rewrites,
  with `changed: ["heartbeat", "session.lastActivity"]`. It's off by default.
- `focus` resolves an exact id, then a unique id prefix, then a unique
  case-insensitive substring of `session.name` (a single fresh match wins over
  stale ones). It prints `{"ok":true,"id":…}` or
  `{"ok":false,"id"?:…,"reason":…,"candidates"?:[{id,name}]}` and exits 0 or 1.

Feed semantics (`feed.ts` `diffLive`):

- Only **fresh** sessions are announced. `snapshot.sessions` lists fresh sessions only.
- `upsert` is sent when a new session becomes fresh (`changed: ["session","presence"]`,
  or just `["session"]` for a metadata-only record),
  when its content changes (`changed` lists dotted paths such as `presence.activity`,
  `presence.workers` or `session.name`), and when a stale session comes back
  (`changed` includes `"fresh"`). Each upsert carries the complete
  `LiveSession`, so replace your copy rather than merging.
- `remove` reasons: `left` (file deleted, e.g. clean exit), `stale` (heartbeat
  older than 15 s), `dead` (pid gone), `invalid` (record became unreadable; CLI only).
- Heartbeat-only rewrites and `note` traffic never produce events (unless
  `watch --heartbeats` is set).
- `error` events report an unreadable directory (once until it recovers) and
  `invalid record: <file>` (once per file until it's fixed or removed).

`LiveSession` = `{ id, record, fresh, age, legacy, state, attention, workersWorking }`,
where `attention` is `needs-input` | `error` | `none`, `legacy` means `schemaVersion`
is absent, and `workersWorking` comes from `workerCounts` or a tally of `workers`.

One example line per event (records shortened to the legacy example for brevity):

```ndjson
{"type":"hello","at":1789804800000,"feedVersion":1,"schemaVersion":2,"dir":"/home/dev/.pi/agent/sessions/live"}
{"type":"snapshot","at":1789804800000,"sessions":[{"id":"p51007-a0c4e9b7","record":{"v":1,"session":{"id":"p51007-a0c4e9b7","name":"notes","cwd":"/home/dev/notes","model":"claude-sonnet-5","pid":51007,"startedAt":1789803000000,"lastActivity":1789804798000,"status":"Idle"},"heartbeat":1789804798000},"fresh":true,"age":2000,"legacy":true,"state":"idle","attention":"none","workersWorking":0}]}
{"type":"upsert","at":1789804803000,"session":{"id":"p51007-a0c4e9b7","record":{"v":1,"session":{"id":"p51007-a0c4e9b7","name":"notes","cwd":"/home/dev/notes","model":"claude-sonnet-5","pid":51007,"startedAt":1789803000000,"lastActivity":1789804803000,"status":"Running: read"},"heartbeat":1789804803000},"fresh":true,"age":0,"legacy":true,"state":"working","attention":"none","workersWorking":0},"changed":["session.status"]}
{"type":"remove","at":1789804830000,"id":"p51007-a0c4e9b7","reason":"stale"}
{"type":"error","at":1789804830000,"message":"EACCES: permission denied, scandir '/home/dev/.pi/agent/sessions/live'"}
```

Consumers should ignore event types and keys they don't recognize. `feedVersion` in
`hello` changes only when an existing event's meaning changes.
