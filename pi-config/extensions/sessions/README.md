# Live Pi sessions

Global local extension. Running pi sessions on this machine find each other
through a filesystem presence bus (`presence.ts`). There's no daemon, broker or
socket, and the directory is the registry:

```
~/.pi/agent/sessions/live/<id>.json        <id> = p<pid>-<8 hex>, dir mode 0700
```

- Each process writes its whole record to a dotfile temp and `rename(2)`s it
  into place, so readers never see a partial file. It rewrites right away on
  any change. Otherwise it writes a heartbeat at least 3 s apart, checked on a
  2 s poll (so roughly every 3–4 s). A clean shutdown deletes the file.
- A peer whose heartbeat is older than **15 s** is hidden. Its file is deleted
  once its pid is dead or the heartbeat is older than **90 s**. A paused peer
  (busy event loop) keeps its file and comes back when it resumes.
- Records are `v: 1` plus `schemaVersion: 2`. v2 fields are all optional, so
  v1 peers and v2 peers read each other's records. v1 peers show up dimmed with
  `reload to enrich`.

This lists live processes only. It isn't a saved-history browser (use Pi's
`/resume` for that). Every participating session must load this extension. New
sessions load it automatically; run `/reload` in sessions that are already open.

## In pi

- **Alt+S** or **`/sessions [query]`** opens the overlay. A query pre-fills the search.
- **Alt+Shift+S** or **`/sessions-back`** focuses the most recent other live
  session from an 8-entry recents list. Focusing a session also records the
  session you came from in the target, so pressing it again there takes you back.

### Overlay

Sessions are grouped by what needs you first. Empty groups are hidden:

| group | contains | order |
|---|---|---|
| NEEDS INPUT | waiting on a prompt, or errored | longest-waiting first |
| WORKING | agent running, or any worker still working | most recent activity first |
| IDLE | everything else that's reachable | unseen completions first, then most recently completed |
| UNREACHABLE | stale or disconnected | by name |

Your own session (`· you`) is pinned last in its group. Row glyphs: `●` working,
`○` idle, `⚑` needs input, `✗` error, `◌` stale, `•` unseen completion,
`◆working/total▸` workers. On two-line rows (width ≥ 100) the second line shows
the topic-outline "now" line or the status, plus ` · # <last heading>` when it's shared.

Typing fuzzy-searches `name cwd`. While a query is active the groups collapse
into one ranked `Matches · N` list. Live updates don't re-rank it or move your selection.

Keys. The footer shows the same hints: `↑↓ select · ←→ workers · Tab detail ·
Enter focus · [Ctrl+U seen] · Esc close · n/N`.

- **↑/↓** select, **PgUp/PgDn** move 10. **→** expands a row's workers, **←** collapses them.
- **Tab** cycles the pane: detail → preview → off.
- **Enter** focuses that session's existing window. On a worker row, or a
  preview-only session, it opens the preview instead.
- **Ctrl+U** marks every session seen. Its footer hint only appears while
  something is unseen.
- **Esc** (or **Ctrl+C**) closes without touching your draft or cancelling agent work.
- Up/down, page, confirm and cancel use Pi's injected `tui.select.*`
  keybindings, and the footer labels follow them. ←/→, Tab and Ctrl+U are fixed.

The detail pane shows identity (name, pid, model, host, cwd), then state (tools,
`read · auth.ts`-style detail, error text, and `preview only · <reason>`), the
outline summary, workers, a 16-bucket tool-activity sparkline with turn count,
and the latest reply. The preview pane shows the wrapped latest reply, or the
selected worker's output.

Layouts adapt to the overlay width (92% of the terminal):

- **≥ 140 columns:** list and detail side by side. When Tab is off, the list shows by itself.
- **100–139:** the list is stacked above the detail pane. The detail pane is dropped when
  the body is shorter than 10 rows, or when Tab is off.
- **< 100:** one-line rows. The list shows until you press Tab or Enter on a
  preview-only row, then the pane replaces the list entirely. Tab back to `off`
  for the list. Group headers need ≥ 8 inner rows.
- **Tiny terminals:** below 24 columns frames become a title rule instead of a box.
  The narrow layout drops its frame below 6 body rows. There's no footer below
  5 rows, and at ≤ 2 rows only the selected row is shown.

Overlay contract (`ui.ts`): `new SessionsOverlay(theme, refresh, height, done,
keys = new KeybindingsManager(TUI_KEYBINDINGS), { initialQuery?, onMarkAllSeen? })`.
The host feeds it with `update(views, connectionLabel)` and `setQuery(text)`.
`done(id)` means focus that id, and `done(undefined)` means closed. The
Ctrl+U binding exists only when `onMarkAllSeen` is passed.

### Footer status

In TUI mode the footer status is `Sessions: N live · a busy · b input · c unseen`.
The counts are N reachable sessions (including this one), busy (working)
sessions, sessions needing input or errored, and unseen completions.
Cross-session subagent worker totals are no longer summed into the footer;
they still show per session in the Alt+S overlay. Zero counts are omitted, so
an all-quiet footer is just `Sessions: N live`. While the bus is down it shows `Sessions: disconnected`.

"Unseen" means a parent run settled or a worker finished since you last
focused that session. It doesn't mean the task succeeded, and errors are
labelled separately. Unseen markers are local to this pi instance and reset on reload.

## Config

`~/.pi/agent/sessions.json` (optional). It's read at session start and never
written. A missing or malformed file means defaults:

```json
{ "budgetBytes": 16384 }
```

- `budgetBytes` (default `16384`, clamped to 4096–65536): the total UTF-8
  budget for this session's record. When a record is over budget, content is
  dropped in the order documented in `public/SCHEMA.md` §5. `workerCounts`
  stays truthful when workers are dropped.

## Workers

`subagents/index.ts` publishes authoritative worker snapshots on
`subagents:workers-snapshot`. It answers `subagents:workers-request` and
covers both the Pi and Claude backends in that manager (see `workers.ts` for
the contract). At most 40 workers go on the bus. Third-party worker managers
need an adapter, because inferring workers from tool calls isn't reliable.

## External consumers

The full contract is in **[`public/SCHEMA.md`](public/SCHEMA.md)**, with JSON
Schemas and examples next to it. In short:

- The versioned live record (`v: 1`, `schemaVersion: 2`) is readable by
  anything, but untrusted: parse it defensively and ignore unknown keys.
  `note` is pi-internal and `target` is opaque. Use the reference readers
  `schema.ts` + `feed.ts` (node builtins only) if you can.
- `feed.ts` diffs directory snapshots into an NDJSON **FeedEvent** stream:
  `hello`, `snapshot`, `upsert` (with dotted `changed` paths), `remove`
  (`left`/`stale`/`dead`/`invalid`) and `error`.
- **Focusing:** external tools must focus **only** through `pi-sessions focus`.
  It re-reads the record and re-validates the full identity before it does
  anything. Never feed `target.address` to `hyprctl` (or anything similar) yourself.

### `pi-sessions` CLI

`bin/pi-sessions.ts` is a standalone script that needs node ≥ 23.6 (type
stripping) or bun. It doesn't need pi installed and never writes to the live
directory. `install.sh` symlinks it to `~/.local/bin/pi-sessions`.

| command | output |
|---|---|
| `snapshot [--include-stale]` | one `snapshot` event (JSON); fresh sessions only unless `--include-stale` |
| `watch [--heartbeats] [--snapshot-every 30s]` | NDJSON: `hello`, `snapshot`, then `upsert`/`remove`/`error` |
| `focus <id-or-name>` | `{"ok":true,"id":…}` or `{"ok":false,"reason":…}` after full re-validation |
| `menu [--format dmenu\|json]` | walker/dmenu-ready `<label>\t<id>` lines, or a JSON array |

- `--dir <path>` works on every command. It defaults to `$PI_SESSIONS_DIR`,
  else `~/.pi/agent/sessions/live`.
- Exit codes: `0` ok, `1` runtime/record error (including a refused focus),
  `2` usage error, with the usage text on stderr. `--help` also exits 2.
- `watch` diffs content and dedupes heartbeat noise: the 3–4 s rewrites and
  `note` traffic produce no events unless you pass `--heartbeats`.
  `--snapshot-every` re-emits full snapshots (`ms`/`s`/`m`, `0` = off).
- `focus` accepts an exact id, a unique id prefix, or a unique name substring.
  Ambiguous matches return `candidates`.
- `menu` sorts attention first, then working, then idle by name. Take the text
  after the final tab and pass it to `pi-sessions focus`. For example:
  `pi-sessions menu | walker --dmenu | cut -f2 | xargs -r pi-sessions focus`.
- A `pi-sessions serve` HTTP/SSE bridge is deferred.

## Focusing safety

On this Linux/Ghostty/Hyprland setup each session adds a unique `[pi:<pid>:<8 hex>]`
marker to its terminal title. It refreshes the title shortly after start and on
renames, and re-runs discovery on every 5 s heartbeat. Discovery finds the exact
visible title and records the origin process, start times, TTY, Ghostty
ancestor, Hyprland instance, boot id and window address as a `FocusTarget`.

Every focus, whether it comes from the overlay, `/sessions-back` or `pi-sessions
focus`, goes through the same gates:

1. The session must be fresh and its roster pid alive.
2. `checkFocusable(presence)` must pass. The session must not have published
   `focusable: false`, and its target must pass `isFocusTarget` validation.
3. The target's origin pid must match the session's pid.
4. `focusTarget` rebuilds the whole identity from `/proc`, Ghostty, tmux and
   Hyprland and compares it field by field before it runs `hyprctl dispatch focuswindow`.

The extension never resumes a JSONL file, spawns a duplicate session, sends
terminal input, changes desktop configuration or focuses anything automatically.

Some sessions are **preview-only**: headless (non-TUI) sessions, hidden Ghostty
tabs or splits, unsupported terminals or compositors, ambiguous layouts, and
stale or disconnected peers. A session publishes why through `focusable: false`
and `focusReason`. The overlay shows `preview only · <reason>`, and the CLI
returns it as `reason`. A window showing a different active tab is never
silently switched. tmux support is conservative: it needs the exact
socket/pane identity, exactly one writable attached client, and an unambiguous
Ghostty/Hyprland host. Herdr and other host adapters aren't included yet.

## Privacy

The bus is same-user only (directory mode 0700), and all text is stripped of
terminal controls both when written and when read. Records **never** contain
user prompts, thinking, bash commands, tool arguments or tool output.

- **Assistant text is bounded.** The latest reply preview is capped at 2,000
  characters (600 under budget pressure), and error text at 200. Worker
  previews are capped at 180.
- **`toolDetail` is a basename only.** It's published only for `read`, `edit`
  and `write` (for example `edit · auth.ts`). Other tools share just their names.
- **Outline text is an LLM paraphrase from topic-outline,** gated by its
  `shareWithSessions` (`off` | `now-only` | `summary`) and `shareLastHeading`
  settings. `lastHeading` is the exception: it can be the latest `#` heading you
  typed (≤ 80 characters). Your own `~/.pi/agent/topic-outline.json` currently
  uses `"summary"`, which also shares the overall gist, topic headings, and
  per-topic bullets (≤ 6 topics × 3 bullets).
- **Metadata:** each record includes `cwd`, `model`, `pid`, `host`, the pi
  session id, and `sessionFile`, the absolute path to the JSONL transcript (never
  its contents).

There's no second daemon and no persistent transcript copy. Consumers must not
copy records anywhere more widely readable.

## Tests

```sh
node ~/pi-config/extensions/sessions/test.mjs          # everything: 105 tests
node --test ~/pi-config/extensions/sessions/cli.test.ts  # CLI only, plain node: 8 tests
```

`test.mjs` loads the installed Pi packages through Jiti, the same way the
extension loader does. It runs the in-extension integration tests and every
`*.test.ts`, including `cli.test.ts`. `cli.test.ts` is erasable TypeScript and
spawns the real `bin/pi-sessions.ts` under plain node. Focus tests use injected
OS/command mocks, and the CLI tests clear `HYPRLAND_INSTANCE_SIGNATURE`, so no
test can focus a real window.
