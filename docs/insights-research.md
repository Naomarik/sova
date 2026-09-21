# pi-web insights — research

## Data sources

_Author: backend. Verified first-hand on 2026-09-19 against the files on this machine (read-only)._

**Bottom line:** everything is readable from disk by a foreign process, no extension patch needed.
Usage = one cache file. Live workers/teams = the `sessions` extension's live registry joined with
team entries in the parent session JSONL. Summaries = `topic-outline` + `compaction` entries in
session JSONL (plus a fresher outline copy in the live registry for running sessions).

### 1. Usage limits: `~/.pi/agent/cache/usage-status.json`

Writer: `~/.pi/agent/extensions/usage-status.ts` (symlink → `pi-config/extensions/usage-status.ts` in this repo).
Written atomically (tmp + `rename`), so readers never see a partial file. No secrets in it.
Lockfile `usage-status.json.lock` beside it: ignore it.

```jsonc
{
  "fetchedAt": 1789796008254,        // ms epoch of the last fetch attempt (success or not)
  "nextFetchAt": 1789796158254,      // fetchedAt + 150s (ok) or + 60s (any provider failed)
  "ollama": { "state": "ok", "usedPct": 75.6 },                 // | nokey | badkey | na   (monthly)
  "openai": { "state": "ok", "windows": [{ "label": "7d", "pct": 95 }] }, // | nologin | expired | na
                                     // labels "5h" | "7d" | "pri"; NO resetsAt for openai
  "claude": { "state": "ok",                                     // | nologin | expired
              "fiveHour":  { "pct": 96, "resetsAt": "2026-09-19T07:50:00.621229+00:00" },
              "sevenDay":  { "pct": 41, "resetsAt": "2026-09-25T18:00:00.621249+00:00" } },
              // "sevenDayOpus" optional; every window optional
  "zai":    { "state": "ok", "fiveHour": { "label": "5h", "pct": 12 },      // | nokey | badkey | na
              "mcp": { "pct": 0, "used": 0, "limit": 1000 } },              // MCP call quota
  "deepseek": { "state": "ok", "available": true,                            // | nokey | badkey | na
              "balances": [{ "currency": "USD", "total": 4.29, "granted": 0, "toppedUp": 4.29 }] },
                                     // no usage API: prepaid credit only (GET /user/balance)
  "errors": {}                       // { ollama?, openai?, claude?, zai?, deepseek? }: message of the LAST failed fetch
}
```

`schemaVersion` is 3 since the `deepseek` key was added (2 before it).

- **Per-provider staleness:** on a failed fetch the previous provider value is kept and
  `errors.<provider>` is set (`"timeout"`, `"claude HTTP 529"`…). A provider key can be absent
  entirely if it has never succeeded (then only `errors.<provider>` explains why).
- **Whole-file staleness:** only pi processes in **TUI mode** refresh it (on `session_start`, every
  180s tick, and on `agent_settled`), rate-limited machine-wide via the lock. With no TUI pi running
  the file simply ages; nothing marks it. So age = `now - fetchedAt`; treat > ~10 min as stale.
- **Absent:** no file until the first TUI pi with the extension has fetched once. **Corrupt:** the
  extension itself treats non-`{fetchedAt:number, errors:object}` as "no cache". Server does the same.
- Extension's own colour thresholds: ≥80% error, ≥50% warning.
- Resets can be in the past when the file is stale (a window's `resetsAt` < now ⇒ the pct is
  obsolete); the UI should say so rather than show a stale 96%.

### 2. Live subagents + teams: `~/.pi/agent/sessions/live/*.json`

The in-memory bus event `subagents:workers-snapshot` (what `working-subagent-count.ts` counts) is
process-local, **but** the `sessions` extension subscribes to the same bus and republishes it in its
live record. Public, versioned contract: `pi-config/extensions/sessions/public/SCHEMA.md`
(+ `live-record.schema.json`, reference reader `schema.ts`). `server/live.ts` already reads these files
for the `live` badge. One file per pi process, atomic rename, rewritten on change and every ~3–4s.

Relevant fields (all under `presence`, all optional in v2, parse defensively):

| field | shape |
|---|---|
| `session` | `{id, cwd, model, pid, startedAt, lastActivity, name?, sessionId?, sessionFile?, mode? tui\|rpc\|json\|print}` |
| `presence.workers[]` (≤40) | `{id "ag_NN", name, status starting\|running\|waiting\|stopping\|done\|error\|killed, model?, preview? ≤180, backend? pi\|claude-code, startedAt?, lastActivity?, endedAt?, outcome? success\|error\|aborted}` |
| `presence.workerCounts` | `{total, working, waiting, done, error, killed}`: complete even when `workers[]` is trimmed |
| `presence.activity` | `{state working\|idle\|needs-input\|error, since, tools?, toolDetail?, turns?, buckets?[16], …}` |
| `presence.outline` | topic-outline broadcast: `{now, overall, topics[] (headings ≤12), lastHeading?, state, generatedAt, detail?[{heading, bullets[]}]}` |
| `heartbeat` | ms epoch. Fresh = ≤15s old and pid alive. Pid dead = gone. |

- "Working" = the same rule as working-subagent-count.ts: status not in `waiting|done|error|killed`.
  `workerCounts.working` already encodes that (starting+running+stopping+unknown).
- Live workers list has **no `teamId`** (the bus snapshot has it since today; the sessions extension
  doesn't forward it). Not needed: see teams below.
- Size trimming: finished workers are dropped first from `workers[]`, so a finished team member may
  be missing from the live record ⇒ status unknown, not "gone".
- Must never write/delete in `live/` (contract §2). The embedded runtimes of *this* server also write
  records with our own pid; for insights these are genuine (a web chat can spawn workers), so they are
  included (unlike `readLive()` for the TUI-busy check, which skips own pid).

### 3. Teams: `subagents-team-v1` custom entries in the **parent** session JSONL

Teams are persisted only here (`teams.ts` `decodeTeamEntry`). No registry file, no pid link.

```jsonc
{"type":"custom","customType":"subagents-team-v1","id":"…","parentId":"…","timestamp":"…","data":
  {"version":1,"op":"create","team":{"id":"team_02","name":"pi-web-insights","objective":"…","createdAt":1789796000145},
   "members":[{"workerId":"ag_08","role":"lead","ownedPaths":[],"orchestrator":true,
               "backend":"claude-code","model":"opus[1m]","groupId":"run_05","addedAt":1789796000145}]}}
{"type":"custom","customType":"subagents-team-v1","data":{"version":1,"op":"add","teamId":"team_01","members":[…]}}
```

- **Join:** live record `session.sessionFile` → that JSONL's team entries → match `members[].workerId`
  against `presence.workers[].id`. Worker ids are never reused within a session (counters are restored
  from `subagents-counters-v2` entries), so a match is authoritative. Verified now: the boss session's
  record lists `ag_08..ag_11` running = team_02 members.
- **History teams** (parent session not running, or created before a `/reload`, which kills workers):
  roster only; the extension itself never re-attaches them. Last known status per member can be
  parsed from `custom_message` entries `customType:"subagent-complete"`, content first line
  `### ag_08 (lead) — waiting · task success` (+ `Session: <child session id>`). Older files use
  `Subagent ag_02 (quick-2) finished its task.`, so parse best-effort.
- Use the active branch (extension's `restoreHistory` does). Present on this machine in 2 files.
- `/tmp/pi-subagents-teams-*/team_NN/ag_NN/{inbox.jsonl,requests,responses}` = mailbox, 0700, removed
  at parent shutdown, no status and no link to the parent session. **Not used.**
- Legacy `subagent-snapshot` custom entries (old extension, May 2026): ignore.

### 4. Session summaries: `topic-outline` custom entries (+ compaction)

Writer: `pi-config/extensions/topic-outline/` (`state.ts`, `types.ts`). Each summarizer run appends a
**full snapshot** (`pi.appendEntry("topic-outline", data)`, up to ~6KB/line, 18 snapshots in the boss
session). The extension restores the **latest snapshot on the active branch**; so does the server.

```jsonc
{"type":"custom","customType":"topic-outline","id":"d9e70dcb","parentId":"…","timestamp":"…","data":{
  "version":2,
  "now":"Audit and intercom removal complete; …",          // 1-line current status
  "overall":"Live topical outline of … Pi extensions.",    // 1-line session gist
  "topics":[{"id":"t1","heading":"Searching Pi extensions for incremental summaries",
             "anchor":{"entryId":"7c4350bd","role":"assistant","timestamp":1789762647256,"fingerprint":"…"},
             "summary":["bullet", "bullet", "bullet"],   // ≤3 bullets (config limits.maxBullets)
             "at":1789785788237, "manual":true?}],        // manual = user typed a "# heading"
  "topicCounter":9, "basisLeafId":"d813b028", "generatedAt":1789788276310,
  "state":"fresh|stale|none|failed-keeping-last",
  "lastHeading":"…"?, "lastManualHeading":""?}}
```

- `anchor.entryId` is a session entry id ⇒ jump target: `TranscriptItem.id` is the entry id (assistant
  blocks are `${entryId}:${i}`), so the UI can scroll to a topic.
- Present in 17 session files (93 snapshots). Config `~/.pi/agent/topic-outline.json` (summarizers,
  `shareWithSessions:"summary"`), which also gates what goes into the live record's `outline`.
- For a **running** session the live record's `presence.outline` can be newer (`state` `updating`/
  `drafting` only exist there); its `topics` are headings only, so bullets always come from the JSONL.

**Compaction** (`type:"compaction"`, pi core; only 1 file on this machine has one):
`{id, parentId, timestamp, summary (markdown, ~2–3KB), firstKeptEntryId, tokensBefore, details:{readFiles[], modifiedFiles[]}, fromHook}`.
Already shown as `kind:"info"` transcript rows; the API adds them as a structured list.
`branch_summary` entries: none on this machine.

## API

_Author: backend. Proposal; types would go in `shared/protocol.ts` via lead. All GET, read-only,
never write any `~/.pi` state. Missing/corrupt sources give an honest empty/unavailable payload
with 200, never 500. Caches: usage by file mtime; per-session JSONL parse by (mtime, size) like
`sessions-index.ts`; live dir re-read per request (a few ≤16KB files)._

```ts
// GET /api/insights/usage   (as shipped in shared/protocol.ts)
export interface UsageWindow { label: string; pct: number; resetsAt?: string; // "5h" | "7d" | "7d opus" | "7d scoped" | "month" | "pri" | "plan" | "mcp"
  used?: number; limit?: number;   // raw counts when the provider exposes them (z.ai MCP calls)
  scope?: string;                  // model family, when the window only covers a subset ("7d scoped" + "Fable")
  active?: boolean }               // the limit the current model counts against
export interface UsageBalance {    // prepaid credit, instead of windows (DeepSeek)
  currency: string; total: number; granted: number; toppedUp: number;
  available: boolean;              // false: the provider says calls aren't fundable
}
export interface UsageProvider {
  id: "claude" | "openai" | "ollama" | "zai" | "deepseek";
  state: "ok" | "nologin" | "expired" | "nokey" | "badkey" | "na" | "error"; // "error" = never fetched OK
  windows: UsageWindow[];          // [] unless state "ok"; always [] for a credit provider
  balance?: UsageBalance;          // set instead of windows when state "ok" (DeepSeek only)
  error?: string;                  // last fetch failed; windows/balance (if any) are from an earlier fetch
}
// A provider KEY missing from the cache we just read means an older pi session (holding a
// pre-deepseek extension in memory) rewrote it at schemaVersion 2. The server then serves that
// provider's LAST KNOWN reading from ~/.pi/agent/pi-web/usage-last-known.json (server/usage-
// last-known.ts: ok readings that carry windows or a balance, never an error), capped at 24h,
// with error = "an older pi session is rewriting the cache (run /reload in it)" — which the UI
// already renders as "Stale" + "Showing the previous reading". A key that IS present always
// wins, error/na included, and with nothing stored (or a reading older than 24h) the provider
// stays state:"error", windows: [], error:"no data".
export interface UsageInsight {
  available: boolean;              // false: cache file missing or unreadable (reason says which)
  reason?: "missing" | "corrupt";
  fetchedAt: number | null;        // ms epoch
  nextFetchAt: number | null;
  stale: boolean;                  // now - fetchedAt > 10 min (no TUI pi refreshing it)
  providers: UsageProvider[];      // fixed order: claude, openai, ollama, zai, deepseek
}

// GET /api/insights/agents   (all live pi processes; poll ~5s)
export type WorkerStatus = "starting" | "running" | "waiting" | "stopping" | "done" | "error" | "killed";
export interface WorkerInfo {
  id: string; name: string; status: WorkerStatus; working: boolean;
  model?: string; backend?: string; preview?: string;
  startedAt?: number; lastActivity?: number; endedAt?: number;
  outcome?: "success" | "error" | "aborted";
  teamId?: string;                 // filled by the server's JSONL join
}
export interface TeamMember {
  workerId: string; role: string; orchestrator: boolean; backend: string; model?: string;
  ownedPaths: string[]; addedAt: number;
  worker: WorkerInfo | null;       // null: not in the live record (history team, or trimmed finished worker)
  lastReport?: { status: string; outcome?: string; at: string }; // from the last subagent-complete message
}
export interface TeamInfo {
  id: string; name: string; objective: string; createdAt: number;
  parentPath: string;              // session key → #/s/<path>
  live: boolean;                   // parent session currently running
  members: TeamMember[];
  working: number;                 // members whose worker.working
}
export interface LiveAgentSession {
  path: string | null;             // canonical session path (null if outside the sessions dir / ephemeral)
  sessionId: string | null; name: string | null; cwd: string; pid: number; mode: string | null;
  fresh: boolean;                  // heartbeat ≤ 15s (stale records kept, flagged)
  state: "working" | "idle" | "needs-input" | "error";
  workerCounts: { total: number; working: number; waiting: number; done: number; error: number; killed: number };
  workers: WorkerInfo[];           // may be shorter than workerCounts.total
  teams: TeamInfo[];               // teams created in this session (live join)
}
export interface AgentsInsight {
  at: number;
  totals: { sessions: number; working: number; total: number; teams: number; teamWorking: number; soloWorking: number };
  sessions: LiveAgentSession[];    // working first, then by lastActivity
}

// GET /api/insights/session?path=   (per-session panel; 400/404 like /api/transcript)
export interface OutlineTopic {
  id: string; heading: string; bullets: string[]; at: number; manual: boolean;
  entryId: string | null;          // anchor → TranscriptItem id to scroll to
}
export interface SessionOutline {
  now: string; overall: string; lastHeading: string | null;
  state: "none" | "drafting" | "fresh" | "updating" | "stale" | "failed-keeping-last";
  generatedAt: number;             // 0 = never
  topics: OutlineTopic[];
}
export interface CompactionInfo {
  id: string; timestamp: string; tokensBefore: number | null; summary: string;
  readFiles: string[]; modifiedFiles: string[];
}
export interface SessionInsight {
  outline: SessionOutline | null;  // null: no topic-outline entries on the active branch
  compactions: CompactionInfo[];   // active branch, oldest first
  teams: TeamInfo[];               // live-joined when the session is running, else history
}
```

Optional, lead's call (touches the existing contract): `SessionSummary.live.workers?: {working, total}`
from `workerCounts`, so sidebar rows can badge "2 working" with no extra request.

Implementation notes: new `server/insights.ts` (usage / agents / session readers), three routes in
`server/index.ts`; reuses `resolveSessionPath`, `canonicalPath`, `activeBranch` + `parseLines` from
`transcript.ts`. Status values not in the enum map to `running` (schema rule); unknown activity state
maps to `idle`. No extension changes required.

As implemented (`server/insights.ts`, `server/live.ts` `readLiveRecords`):
- Usage: a provider with `state:"ok"` but no readable window is reported as `na` (the extension
  shows "n/a"). `error` is set whenever `errors.<provider>` is, even with windows (= previous reading).
- **An absent provider key falls back to the last known reading (24h cap).** The cache is shared,
  and a pi session started before a provider existed keeps rewriting it from the extension it has
  in memory (`schemaVersion` 2, no `deepseek` key) — the fix in those TUIs is `/reload`, but pi-web
  must not report a provider it read minutes ago as "no data". `server/usage-last-known.ts` persists
  every `state:"ok"` reading that carries windows or a balance to
  `~/.pi/agent/pi-web/usage-last-known.json` (written only when a stored reading changed, never with
  an `error`); `getUsageInsight()` reuses one for any provider whose key is `undefined` in the cache,
  younger than **24 h**, and sets `error` to `an older pi session is rewriting the cache (run /reload
  in it)`. Only key absence triggers it: a key that says `error`/`na` is the extension's own answer
  and wins, and an expired or empty store leaves the old `error` / `no data` behaviour untouched.
- **DeepSeek (cache `schemaVersion` 3) has a balance, not windows.** There is no usage/quota API for
  it — the only account data is the prepaid credit at `GET https://api.deepseek.com/user/balance` —
  so it reports `balance` and `windows: []`: no percentage, no meter bar and no reset time. It does
  reach the sidebar glance, as money rather than a percentage — rounded to whole units there
  (`DS $4`), exact in the row's tooltip and on the card (`$4.29`). The server takes the **first** readable entry of
  `deepseek.balances[]` (an object with a non-empty `currency` and a finite `total`; `granted` and
  `toppedUp` default to 0), and `available` comes from the provider's own `available !== false`.
  `state:"ok"` with no readable balance follows the same rule as a windowed provider: `na`.
- Agents: `totals` skip rpc-mode records (headless pis such as subagent workers; they stay in
  `sessions[]` with `mode:"rpc"`). `working`/`teamWorking`/`soloWorking` count only `fresh` records;
  `sessions`/`total`/`teams` count all. A heartbeat > 5 min in the future is treated as not fresh.
- `TeamMember.lastReport.status` is the settle status from the last `subagent-complete` message
  (`waiting`, `error`, …; `finished` for the old message format), `outcome` the task outcome.
- Session outline for a running session: the live record's `now`/`overall`/`state`/`lastHeading`
  win when its `generatedAt` ≥ the JSONL snapshot's; topics/bullets always come from the JSONL
  (or, before the first snapshot, headings + shared `detail` bullets from the broadcast, `entryId:null`).
- `SessionSummary.live.workers` comes from `presence.workerCounts` via `readLive()`; omitted for
  records without it.

## Frontend integration

_Author: frontend. Read-only study of `src/` as of b71fa09 + the working tree._

### How the app is built today

- **Stack.** SolidJS + Vite. Signals, `createResource`, `createMemo`, `<Show>/<For>/<Switch>`,
  `onCleanup` for timers and sockets. Styles: `src/design/{tokens,base}.css` (designer) plus a
  small `src/app.css` for glue. Token CSS only, no component library.
- **Routing** (`src/App.tsx` `pathFromHash`). Hash only: `#/` = list, `#/s/<encodeURIComponent(path)>`
  = open session. Anything that doesn't match `^#\/s\/` currently counts as "no session".
  At <768px `.app[data-view="list"|"session"]` decides which column shows.
- **Shell.** `<Sidebar>` (aside: brand · Refresh · New Session, search + count row with the
  "N live" chip, then "Live & web" region and a collapsible Archive) + `<main class="app-main">`
  (session-head + `WatchView` or `ChatView`, or a centered `.empty` state when nothing is open).
- **REST.** `src/lib/api.ts` `request<T>(url)`: throws `ApiError(message, status)`; message is the
  server's `{error}` string, status `0` = server unreachable. The session list uses a
  `createResource` whose fetcher never rejects: it keeps the previous value and sets a separate
  error signal, so stale data stays on screen under an error `Banner` with Retry. Refetch on window
  `focus`; 10s `setInterval` poll while a watched session is open; `reuseUnchanged` keeps row
  identity so `<For>` doesn't re-render/steal focus.
- **WS.** `src/lib/socket.ts` `createReconnectingSocket(url, {onMessage,onOpen})`: backoff
  1/2/5/5/5s then status `"failed"` with a manual Retry (`ConnectionBanner`). `WatchView` tails
  `/ws/watch` (`snapshot`/`append`); `ChatView` uses `/ws/chat` (`hello`/`event`) and calls
  `onSettled` on `agent_settled`, which refreshes the list.
- **Reusable UI** (`src/components/ui.tsx`): `Banner` (tone info/warn/error/success, title, body,
  action; role=alert for errors), `Chip` (tone, `live` dot, `count`), `Icon` (mask over
  `/icons/<name>.svg`; the name union only covers existing files), `CopyButton`, `GlobalRegions`
  (toasts + one polite live region via `announce()`), `trapFocus`. Formatters in `lib/format.ts`:
  `relativeTime`, `stampTime`, `clockTime`, `tildePath`, `shortModel`.
- **Loading language.** No spinner: skeletons after 300ms, `.live-dot` + words for work in progress,
  pending buttons change label + `aria-disabled`.

### Where insights slot in

1. **Global Insights view — `#/insights`.** New route in `App.tsx` next to `pathFromHash`
   (check `#/insights` first; `#/s/` keeps priority for sessions). Renders in `app-main` instead of
   the empty state; at <768 it needs `data-view="session"` (or a new value the designer styles)
   plus the existing `.app-back` link. Entry points: an icon button in `.sidebar-head` and a
   secondary action on the empty main state. Holds: usage cards, teams list, subagent totals.
2. **Sidebar glance (optional).** The search count row already carries the "N live" chip; a
   "N working" subagents chip and/or a worst-usage chip (e.g. "Claude 5h 96%") fit there,
   linking to `#/insights`. Must stay within the 320px sidebar (see 0728a27 overflow fix).
3. **Per-session summary.** In the session header area, above the transcript: a
   `details.disclosure` "Summary" (topic-outline topics + bullets) under `.session-head`, or a
   `.transcript-banner`-style block. Session-scoped data keyed by the same `path` param. A team
   badge in the header (chip "Team · 3 working") if the session is a team's parent.
4. **Session rows.** If the API adds per-session `workingSubagents`/team info to `SessionSummary`,
   `GroupList` can show a small count chip next to the Live chip, no extra requests.

### Fetch strategy (frontend default unless lead says WS)

- New `src/lib/insights.ts`: `createPolledResource(fetcher, intervalMs)` built on the existing
  "never rejects, keep last value, separate error" pattern; pauses on `document.hidden`,
  refetches on `visibilitychange`/`focus`; on error backs off (5s → 15s → 30s → 60s cap) and
  resets on success. Cleaned up with `onCleanup`.
- Cadence: usage 60s (source file only refreshes ≤ every 3 min); teams/subagents 5s while the
  Insights view (or a sidebar chip) is mounted; per-session summary fetched on open and after
  watch `append` / chat `onSettled` (debounced), no timer.
- Staleness is shown from server-provided timestamps (`fetchedAt`/`updatedAt` → "Updated 4m ago"
  via `relativeTime`, recomputed by the App's 30s `now` tick), never from client fetch time.

### What the UI needs from the API (for backend's `## API`)

- **Usage:** per provider `state` (ok / nologin / expired / nokey / badkey / na / error+message),
  windows `{label, pct, resetsAt?}` in a uniform list (Claude's fiveHour/sevenDay/sevenDayOpus and
  OpenAI's windows normalized to one shape is easiest to render), a `balance` instead of windows for
  a credit provider (DeepSeek), `fetchedAt`, and either a
  `stale` flag or a threshold. `null`/404 distinct from error = "extension not installed".
- **Teams / subagents:** list of teams `{id, name, objective?, parentSessionPath?, members:
  [{id, role, status, model?}], updatedAt}` and a total `working` count using the same idle set as
  working-subagent-count.ts (`waiting|done|error|killed` = not working). `parentSessionPath` lets
  the UI link `#/s/…`. A `source` or `available:false` when nothing readable on disk exists.
- **Summary:** `GET …?path=` → `{topics:[{title, bullets[]}], updatedAt} | null`, plus compaction
  summaries if backend exposes them (they already appear in transcripts as `kind:"info"` rows).
- All shapes go in `shared/protocol.ts` (both sides import them).

### States each surface must render

loading (skeleton after 300ms) · ok · empty (no teams / no outline yet) · unavailable (extension
or file absent, not logged in, expired) · stale (last good data + "Updated Xm ago" warning) ·
error (keep last data + error `Banner` with Retry). Exact copy comes from the designer's Copy deck.

### Decisions (lead) and open items

- Placements: 1 (`#/insights`, primary home for usage + teams/subagents) and 3 (per-session
  Summary: topic-outline + compaction) ship; 2 (sidebar usage strip) only if the designer's UX
  section says it fits at 320px. 4 depends on per-session data in `SessionSummary`.
- REST polling, no WS for teams.
- Teams (per backend): rosters from `subagents-team-v1` entries in the parent JSONL; live member
  status/counts from the live registry `presence.workers[]`/`workerCounts` (joined by worker id).
  Teams of live sessions render real status; teams whose parent session isn't live render as "history (session not running)" (roster,
  status unknown). The UI never guesses a status it wasn't given.
- rpc-mode live records (subagent pi workers themselves): frontend preference is that they are
  NOT counted as extra workers or listed as teams (they're already members via the parent's
  `presence.workers`); if the API exposes them, flag them (`mode`) so the sidebar "N live" chip
  and the teams view don't double count.
- Still open for the designer: icons (usage, team) and a meter/progress class for usage bars.

## UX

_Author: designer. Proposal for review; written against `spec/overview.md` §0–§9 and the
fold-ai-dev skill v1.8.0. Nothing in `spec/overview.md` / `src/design/` changes until the gate._

### What the data lets us say honestly (drives the copy)

| Surface | Source on disk | What we can claim | What we can't |
|---|---|---|---|
| Usage | `~/.pi/agent/cache/usage-status.json`, plus our own `~/.pi/agent/pi-web/usage-last-known.json` | Per-provider % used per window; Claude reset times; DeepSeek's prepaid credit balance (and whether it can fund calls); file age (`fetchedAt`); per-provider fetch failure (`errors.X`, previous value kept); a reading up to **24 h** old for a provider whose key an older pi session dropped from the cache — labelled as the previous reading, with "run /reload in it" | OpenAI/Ollama reset times (not in the cache). Any percentage, quota or reset for DeepSeek — it has no usage API, only a balance. Anything fresher than the last pi refresh (it only refreshes while some pi runs); anything at all for a provider we have never read (no key, empty store: "no data") |
| Teams | `subagents-team-v1` entries in the **parent** JSONL (roster) + the parent's live record (`sessions/live/*.json`, `presence.workers[]`) while it runs + `subagent-complete` messages | Roster (role, id, model, orchestrator); **live** status per member while the parent runs; **last reported** settle state once it doesn't | Status of an ended team beyond its last report. Workers die with the parent pi, so a team is only *active* while its parent is live |
| Working subagents | live records' `presence.workerCounts` / `workers[]` (backend `/api/insights/agents`) | Live working/idle counts per running pi, heartbeat-fresh ≤15s; solo vs team via the JSONL join | Anything for pi processes that aren't running; a record with a stale heartbeat is "unknown", not "idle" |
| Outline | last `topic-outline` custom entry (v2) | `now`, `overall`, topics (heading, ≤3 bullets, anchor entryId, manual), state `fresh`/`stale`/`failed-keeping-last`, `generatedAt` | — |
| Compaction | `type:"compaction"` entries | Summary markdown, `tokensBefore`, files read/modified | — |

Rule that falls out: **every status we show says its source.** Live-sourced states
(`member.worker` present, record `fresh`) may pulse; reported states (`worker === null`, only
`lastReport`) never pulse and carry "as of `14:06`". A live record with `fresh:false` renders its
workers as reported too ("as of" = heartbeat time), never as working.

### Placement — decisions

1. **Global Insights = a main-pane view at `#/insights`, entered from a pinned sidebar foot row.**
   One line: the head is full at 320px (brand + Refresh + New Session = ~278 of 296px, §2), a
   third sidebar region would scroll away under 48 rows and mix non-session data into the
   session list, and a toggled overlay over main hides the transcript it summarizes — a
   pinned `.sidebar-foot` is always visible, sits in the folded thumb arc, and needs no rail
   (pi-web has one destination, §7).
2. **Per-session outline = a collapsible `details.outline` strip directly under
   `.session-head`**, above the live banner and transcript. Not a side panel (the ≥1120 band
   stays unused, §7, and one markup must work at 475px) and not a popover (a popover is never
   the only path, and topics need scrolling room).
3. **Compaction stays in the transcript where it happened**; its info row becomes a
   disclosure (summary on demand).
4. **Team parents get a count chip in `.session-head`** and in their sidebar row, linking to
   their team card in `#/insights`.
5. No toasts for any insight. Nothing is announced on poll.

### Sidebar foot (entry point)

```html
<!-- after nav.sidebar-list, outside the scroll pane -->
<div class="sidebar-foot">
  <a class="list-row list-row-interactive insights-row" href="#/insights" aria-current="page"?>
    <span class="icon" style="--icon:url(/icons/gauge.svg)" aria-hidden="true"></span>
    <span class="insights-row-text truncate">Claude 5h <span class="text-num">96%</span> · 2 teams · 3 working</span>
    <span class="icon icon-sm" style="--icon:url(/icons/chevron-right.svg)" aria-hidden="true"></span>
  </a>
</div>
```

- 44px row, `--color-surface`, top border `--color-border`, `padding-bottom: env(safe-area-inset-bottom)`.
- Text = live facts, most pressing first: highest-% usage window (`{Provider} {window} {pct}%`),
  then `{n} teams` (active only), then `{n} working` (only with a live source). Segments with
  nothing to say are omitted. No color, no chip: it's a doorway, the view carries status.
- With no data at all: "Insights · usage, teams, and outlines".
- `aria-current="page"` while on `#/insights`, tinted like a selected session row.

### Insights view (`#/insights`)

```
.session-head   [back]  h1 "Insights"   meta "Usage updated 2m ago"          [↻ Refresh Insights]
.insights.pane
  section  h2.insights-section-head  "Usage"
    .insights-grid → .card per provider (Claude, OpenAI, Ollama Cloud, Z.ai, DeepSeek)
       .card-head  title + (chip: Near limit / Rate-limited / Quota used / Stale)
       .card-body  .meter per window
       .card-foot? caption for provider problems
  section  "Teams · 2 active"   (+ "3 working · 2 idle" caption when live-sourced)
    .card per team (active first, then ended, newest first; ended collapse after 5)
  section  "Solo subagents"  (only when there are any)
```

- Folded: `#/insights` sets `data-view="session"` and shows `.app-back`. Cards stack in one
  column; `.insights-grid` goes to 2–3 columns by container query on the pane (≥768 → 2, ≥1040 → 3).
- Order is Usage → Teams → Solo: usage gates the next turn you're about to start.

#### Usage cards

- **Meter per window**, skill's `.meter` family: number first, bar second, never a bar alone.
  - Label: `5-hour` · `7-day` · `7-day · Opus` · `Monthly` (Ollama) · OpenAI `pri` → `Primary`.
  - Value: `Math.round(pct)` + `%`, mono, `.meter-of` " used". No decimals (Ollama's 75.6 → 76%):
    the source rounds anyway, and a decimal implies precision we don't have.
  - DeepSeek has no meter: one `.meter-head` row, label "Balance", value the money left, plus a
    `.meter-context` with the non-zero granted/topped-up parts. No bar, no percentage, no reset.
  - Context (third term): Claude only — "Resets in 2h 17m" under 24h, else "Resets Sep 25";
    absolute `11:50` / ISO in `title`. OpenAI/Ollama: no context line. Never estimate a reset.
  - Fill: **`--color-ink-muted`**, not accent (deviation: pi-web's accent is reserved for
    primary/live/focus, §0). ≥80% fill `--status-warn`; at 100% `--status-error`. Fill color
    always pairs with the head chip word, never alone. Fill never animates.
- **Card chip** (worst window decides; vocabulary per skill "Model availability"):
  | Condition | Chip |
  |---|---|
  | all < 80% | none |
  | any ≥ 80% and < 100% | `.chip.chip-warn` "Near limit" |
  | 5h window ≥ 100% | `.chip.chip-warn` "Rate-limited" (returns on its own) |
  | 7-day / monthly ≥ 100% | `.chip.chip-error` "Quota used" (waits for the reset) |
  | balance `available: false` (DeepSeek) | `.chip.chip-error` "Out of credit" (waits for a top-up) |
  | `errors.X` set, old value kept | neutral `.chip` "Stale" + foot caption |
- **Provider states** (card body replaces meters with one `.text-caption` line, `.chip` in head):
  `nologin`, `expired`, `nokey`, `badkey`, `na`, fetch error with no prior value — copy below.
- **Whole-file staleness**: fresh while `now − fetchedAt < 5 min` (the extension ticks every
  3 min). Head meta always says "Usage updated {rel}". Past 5 min, a `.banner.banner-warn` sits
  above the grid; meters still render (last known is better than nothing, and it says so).
- **File missing** → one `.empty`-style card in the section, no meters (unavailable, not error).
- Skeleton: one `.skeleton` card-shaped block per provider (5) after 300ms.

#### Team cards

```html
<article class="card team-card" id="team_02" aria-labelledby="t-team_02">
  <header class="card-head">
    <h3 class="card-title" id="t-team_02">pi-web-insights</h3>
    <span class="text-mono text-caption">team_02</span>
    <span class="chip">Ended</span>                           <!-- ended only -->
  </header>
  <div class="card-body">
    <p class="team-objective">Add "insights" facilities to the pi-web app…</p>   <!-- 2-line clamp, full in title -->
    <ul class="list team-members">
      <li class="list-row team-member">
        <div class="list-main">
          <p class="list-title">lead <span class="chip chip-count">Orchestrator</span></p>
          <p class="list-meta"><span class="text-mono">ag_08</span> · <span class="text-mono">opus[1m]</span> · as of <span class="text-mono">14:06</span></p>
        </div>
        <span class="chip"><i class="chip-dot"></i>Idle</span>
      </li>
    </ul>
  </div>
  <footer class="card-foot">
    <p class="text-caption">Started 42m ago in <a href="#/s/…">{parent title}</a></p>
  </footer>
</article>
```

- **Active** = parent session is live (`live !== null`). Otherwise the card says "Ended" and
  every member chip reads its last report without pulse — workers stop when their parent pi
  stops, so claiming more would be a lie.
- **Member status chips** (word always; pulse only when live-sourced):
  | Status | Chip | Word |
  |---|---|---|
  | `starting` | `.chip-accent.chip-live` | Starting |
  | `running` | `.chip-accent.chip-live` | Working |
  | `waiting` | `.chip` + dot | Idle (meta adds "last task failed" when outcome ≠ success) |
  | `stopping` | `.chip` + dot | Stopping |
  | `done` | `.chip-success` | Done |
  | `error` | `.chip-error` | Failed |
  | `killed` | `.chip` + dot | Stopped |
  | no report yet | `.chip` | No report yet |
  With disk-only data, the `running`/`starting` rows can't occur; a member whose latest event
  is a steer after its last report is still shown as its last report ("as of …").
- Role is `.list-title` (medium), ids and models mono in meta. Orchestrator is a neutral
  `.chip-count` badge, not a status color. Owned paths are not shown (advisory, noisy); they go
  in the row's `title`.
- Empty: live fact first — "3 sessions live. None of them has a team." / with 0 live:
  "No teams yet. Teams you create in pi show up here while their session runs."

#### "Live" vs "Working" (don't conflate)

- **Live** is session-level: a TUI has the file open. Word "Live", accent pulse. Unchanged.
- **Working** is worker-level: a subagent is mid-task. Word "Working", accent pulse **only**
  on a live source. Both are the skill's "live-run indicator", so both may pulse; the word is
  what distinguishes them and it is never dropped.
- Aggregates are **neutral count chips, no dot, no pulse**: a sidebar row / session head shows
  `.chip.chip-count` "3 working" (live source) or "Team · 4" (disk only), next to — never
  replacing — the Live chip. This keeps one pulsing thing per row.

### Session outline strip

```html
<details class="outline">                      <!-- closed by default; open state per path in sessionStorage -->
  <summary class="outline-summary">
    <span class="icon icon-sm icon-twist" …chevron-right…></span>
    <span class="outline-label">Outline</span>
    <span class="outline-now truncate">· {now}</span>
    <span class="outline-count text-num">12 topics</span>
  </summary>
  <div class="outline-body">                   <!-- max-height var(--outline-max) 40vh (50vh folded); own scroll -->
    <p class="outline-overall">{overall}</p>
    <p class="outline-state text-caption">Updated 3m ago · behind the latest messages</p>  <!-- stale/failed only adds the clause -->
    <ol class="outline-topics">
      <li>
        <details class="outline-topic">
          <summary><span class="outline-topic-heading">Model selection and Claude session limits</span>
                   <span class="text-mono text-caption">14:06</span></summary>
          <ul class="outline-bullets"><li>…</li></ul>
          <button class="button button-sm button-ghost">Jump to Message</button>   <!-- only if anchor row is in the transcript -->
        </details>
      </li>
    </ol>
  </div>
</details>
```

- Progressive disclosure in 3 steps: collapsed row shows the `now` line → open shows `overall`
  + topic headings → each topic opens to its bullets and Jump.
- Manual (`#`) topics prefix the heading with a mono muted `#`.
- **No outline → no strip.** Most sessions have none; an empty strip on every session is noise.
- Updates in place when a newer entry arrives (watch append / chat settle). Open states persist.
- Jump: scroll the anchor's transcript item into view, stop following, show Jump to Latest.
  Hidden when the anchor isn't rendered (compacted away).

### Compaction row (transcript)

The `info` row for compaction becomes a `details.disclosure`:
label "Compacted", preview "· {tokensBefore} tokens summarized" (comma thousands, mono), body
= summary (pre-wrap) then "Files read" / "Files changed" as mono lists (omit empty lists).

### New classes (to add after the gate) and tokens

- Classes: `.sidebar-foot` `.insights-row` `.insights-row-text` · `.insights` `.insights-section`
  `.insights-section-head` `.insights-grid` · `.meter` `.meter-head` `.meter-label` `.meter-value`
  `.meter-of` `.meter-track` `.meter-fill` `.meter-fill-warn` `.meter-fill-error` `.meter-context`
  `.meter-ghost` (skill's family + fill override) · `.card` family already exists; `.team-card`
  `.team-objective` `.team-members` `.team-member` · `.outline` `.outline-summary` `.outline-label`
  `.outline-now` `.outline-count` `.outline-body` `.outline-overall` `.outline-state`
  `.outline-topics` `.outline-topic` `.outline-topic-heading` `.outline-bullets`.
- Tokens: one new layout token `--outline-max` (40vh). **No new colors** — status tokens and
  neutrals cover everything.
- Icons: `gauge.svg` (new, drawn on the system grid — usage / foot row) and `worker.svg`
  (copy from the skill — Teams section head). Copy `runs.svg` only if Solo subagents needs one.
- Motion: no new animation. The pulse is reused only on live-sourced Starting/Working chips.

### Copy deck (draft)

| Where | Copy |
|---|---|
| Foot row | `{Provider} {window} {pct}%` · `{n} teams` · `{n} working` joined by ` · ` · no data: Insights · usage, teams, and outlines |
| View title / refresh | Insights · `aria-label` "Refresh Insights" |
| Head meta | Usage updated {rel} |
| Section heads | Usage · Teams · {n} active · Solo subagents |
| Window labels | 5-hour · 7-day · 7-day · Opus · Monthly · Primary |
| Meter value / context | `{pct}%` used · Resets in {2h 17m} · Resets {Sep 25} |
| Usage chips | Near limit · Rate-limited · Quota used · Stale |
| Stale file banner (warn) | **Usage is {42m} old.** It refreshes while a pi session is open. Open one, or run `/usage-refresh` in pi. |
| File missing | **No usage data yet.** The usage-status extension writes `~/.pi/agent/cache/usage-status.json` while pi runs, and we haven't found it. |
| File unreadable (error) | **Couldn't read usage.** `usage-status.json` wasn't changed. {server message} · `Retry` |
| Provider: nologin | Not signed in. Run `claude /login` (OpenAI: `pi /login`), and it'll show at the next refresh. |
| Provider: expired | Sign-in expired. Run `claude /login` (OpenAI: `pi /login`) to renew it. |
| Provider: nokey | No Ollama Cloud key in `~/.pi/agent/auth.json`. |
| Provider: badkey | Ollama Cloud refused the key in `~/.pi/agent/auth.json`. |
| Provider: na | This account doesn't report usage. |
| Provider: fetch failed, old value kept | Last fetch failed: {error}. Showing the previous reading. |
| Provider: fetch failed, nothing kept | Couldn't fetch usage: {error}. We'll try again at the next refresh. |
| Team chip / active count | Ended · Teams · {n} active · {w} working · {i} idle |
| Member chips | Starting · Working · Idle · Stopping · Done · Failed · Stopped · No report yet |
| Member meta | `{id}` · `{model}` · as of `{HH:MM}` · idle + failed: last task failed |
| Orchestrator badge | Orchestrator |
| Team foot | Started {rel} in {parent session title} |
| Teams empty (some live) | **{n} sessions live. None of them has a team.** |
| Teams empty (none live) | **No teams yet.** Teams you create in pi show up here while their session runs. |
| Teams unavailable (read error) | **Couldn't read teams.** No session files were changed. {server message} · `Retry` |
| Working count unavailable | (omit; never show "0 working" without a live source) |
| Session head / row chip | {n} working · disk only: Team · {members} |
| Outline summary | Outline · {now} · {n} topics |
| Outline state clause | stale: behind the latest messages · failed-keeping-last: last update failed, showing the previous outline |
| Outline updated | Updated {rel} |
| Jump | Jump to Message |
| Compaction | Compacted · {tokens} tokens summarized · Files read · Files changed |

### Resolutions (designer, after green light)

**Canonical spec is now `spec/10-insights.md` §10 (+ §9 "Insights" copy, class index, §7, §8).**
Where this draft differs, §10 wins. Summary of what changed from the draft above:

1. **Live worker status** — backend ships a live source (the sessions live records,
   `AgentsInsight`). Member chips pulse only when `member.worker` is present and its session is
   `fresh`; otherwise they render `lastReport` with "as of `{HH:MM}`" and no pulse.
2. **Usage stale threshold** — 10 min, the server's `UsageInsight.stale` (only TUI pi refreshes
   the file). The UI doesn't compute its own. A window whose `resetsAt` has passed renders
   `.meter-ghost` with "Reset at `{HH:MM}`. New reading at the next refresh."
3. **Ended teams** — not listed in `#/insights` (`AgentsInsight` only carries running parents,
   and a team's workers die with its parent). Teams = active teams only.
4. **"Solo subagents"** is renamed **Subagents**: one `.agent-card` per live session with
   non-team workers.
5. **Sidebar working chip** — neutral `.chip.chip-count` "{n} working" before the Live chip when
   `live.workers.working ≥ 1`. No dot, no pulse.
6. Final class names: `.sidebar-foot` `.insights-row(-text)` · `.insights` `.insights-inner`
   `.insights-section(-head/-count)` `.insights-grid` · `.card-head/-title/-body/-foot` ·
   `.usage-card` `.usage-note` `.meter*` (+ `-fill-warn/-error`, `-ghost`) · `.team-card`
   `.team-objective` `.agent-card` `.member-list` `.member-row` `.member-preview` · `.outline*`
   (incl. `.outline-topic-summary` `.outline-topic-time` `.outline-hash` `.outline-jump`) ·
   `details.disclosure.compaction` `.compaction-summary` `.compaction-files`. New token
   `--outline-max`. New icons `public/icons/gauge.svg` (drawn) and `worker.svg` (from the skill).

Still open for lead: whether an ended team deserves a surface later (for example, a roster in
its parent session under the outline strip). This isn't built now.
