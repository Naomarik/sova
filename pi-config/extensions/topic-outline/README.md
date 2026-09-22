# topic-outline

Live topical outline of the current Pi conversation. **Not compaction** — the outline is
display-only and never changes what the model sees. It maintains markdown-heading-style
topics (usually the concerns you raise) with short summaries of what the agent did,
and it can scroll the fullscreen transcript directly to the message that started a topic.

## What you see

- **Footer status (`§ …`)** — an instant, free "Now" line derived from lifecycle events
  (`Running: edit · auth.ts`, `Needs input`, `Error: …`, `Idle 3m`). No model involved.
- **Alt+O / `/outline`** — right-side overlay panel:
  - the instant Now line plus the latest model-generated one-liner (with its age),
  - topic headings with 1–3 bullets each,
  - **Enter** scrolls the main transcript to the topic's original message (fullscreen mode)
    or opens a read-only peek panel (regular mode / message compacted away / other branch),
  - `r` forces a refresh, `q`/Esc closes.
- **`/outline rebuild`** — force a summarization run, **`/outline status`** — show state.
- User messages starting with `#`/`##` become topics instantly, no model call, and are
  never merged away.

## Summarizer chain

After each settled run (debounced, one run at a time, skipped when nothing changed):

1. **Claude Code CLI with haiku** — spawned directly (`claudeBin`, never via your shell
   alias), no tools, no settings sources, no MCP, `dontAsk` permissions, no session
   persistence, in an empty private temp dir, prompt on stdin, `$0.05` budget cap.
2. **Pi model registry** — `ollama-cloud/deepseek-v4.1-flash` via
   `ctx.modelRegistry.complete()` (Pi's own auth resolution).

Each backend is checked against the user's model policy **at the moment it is called**
(`summarizers/policy-gate.ts`, over `~/.pi/agent/model-policy.json`): one turned off in pi-web's
Settings → Models is never called, and the chain moves to the next. The check is per call, not per
session, so turning a model off stops the next summary rather than waiting for a reload. The chain
counts the denial as a failure, so a backend turned back on rejoins after its backoff.

Every run is also handed a **session anchor**: the earliest user request still on the branch,
clipped to 400 characters and kept in the snapshot (`purpose`) so it outlives compaction and the
delta. It is what `overall` describes — `overall` answers "what is this session about?", front-loaded
so the first few words still read in a narrow list, while `now` stays the latest process update. The
anchor is offered, not asserted: on a session whose outline predates this field it can be a
mid-session message, so the prompt says the existing topics win when the two disagree, and a genuine
change of goal rewrites `overall`.

Failures (missing binary, non-zero exit, timeout, model errors, rate limits, invalid
JSON) fall through the chain with growing per-backend backoff (1m → 5m → 15m). If
everything fails, the last good outline stays in place, marked stale; nothing blocks.

## Config

`~/.pi/agent/topic-outline.json` (project-local `.pi/topic-outline.json` is honored only
for trusted projects):

```json
{
  "summarizers": [
    { "backend": "claude-code", "model": "haiku", "timeoutMs": 45000, "maxBudgetUsd": 0.05 },
    { "backend": "pi", "model": "ollama-cloud/deepseek-v4.1-flash", "timeoutMs": 60000 }
  ],
  "trigger": { "debounceMs": 3000, "minNewMessages": 2 },
  "shareWithSessions": "now-only",
  "shareLastHeading": true,
  "claudeBin": "~/.local/bin/claude",
  "limits": { "maxTopics": 40, "maxBullets": 3 }
}
```

- A `pi` backend model is any `provider/model` id from Pi's registry — point it at a
  local Ollama model if you don't want transcript excerpts going to ollama.com.
- `shareWithSessions`: `off` | `now-only` (default) | `summary`. Controls what the
  `/sessions` extension receives. `summary` adds the overall gist and topic headings.
  It also shares per-topic bullets as `detail` (≤6 most recent topics × ≤3 bullets ×
  ≤120 chars, headings ≤60, control characters stripped); `now-only` never sends them.
- `shareLastHeading` (default `true`, ignored when `shareWithSessions` is `off`): also
  send `lastHeading` so each `/sessions` row shows ` · # <heading>`. `lastHeading` is the
  most recent `#` heading you typed (a repeated heading counts); if you never typed one,
  the most recently created/updated topic's heading; empty when there are no topics.
  Capped at 80 characters. This is short **user-authored** text crossing your own local
  sessions via Intercom — an explicit, opt-out exception to the sessions extension's
  "no raw user prompts" rule. Set `false` to keep it local.

## Persistence

Snapshots travel with the session file as `topic-outline` custom entries
(`pi.appendEntry`) — they are never sent to the model, invisible in the transcript,
follow branch switches (`/tree`), and restore on resume. `lastHeading`/`lastManualHeading`/`purpose`
were added within snapshot version 2; older snapshots restore with them empty. Ephemeral sessions keep the
outline in memory only.

## Known limitations

- **Transcript scrolling requires fullscreen mode** (`tuiMode: "fullscreen"`, Pi docs
  call it experimental). In regular mode the terminal owns the scrollback, so Enter
  always opens peek there. Fullscreen jumping uses undocumented `pi-tui` internals: the
  renderer's primary transcript `ScrollView` (`getPrimaryScrollView().render(width)`, the
  same rows `scrollToTop`/`scrollBy` move through; `tui.render()` only returns one
  transcript row), `scrollToTop`/`scrollBy`/`flash`, and OSC 133 markers. Every call is
  capability-guarded; when unavailable the peek panel shows the original message instead.
  A Pi upgrade could break scrolling — never the rest of the extension.
- Rows are matched to messages by marker ordinal, verified with a letters/numbers-only
  fingerprint (survives markdown styling, wrapping, links, emoji). If an extension
  markdown transformer rewrites the text beyond recognition, the ordinal is used only
  when the transcript's marker count matches the context.
- Topic anchors older than the last compaction can't be scrolled to (transcript rows are
  gone); they fall back to peek, which reads the session file.
- Topics on another `/tree` branch show the original text in peek; the extension never
  navigates branches or alters model context.
- Summaries send excerpted session content (user text, assistant text, tool names and
  result snippets ≤ 500 chars, never bash commands) to the configured backends —
  Anthropic via Claude Code and, on fallback, your `pi` backend provider.

## Debugging jumps

Run pi with `PI_TOPIC_OUTLINE_DEBUG=1` to append one JSON line per jump attempt to
`~/.pi/agent/topic-outline-debug.log` (`at`, `heading`, `asFullscreen`, `ordinalFound`,
`rowsCount`, `markers`, `fingerprintMatched`, `row`, `reason`). Message text is never
logged. Reasons: `ok`, `ok-ordinal-only`, `not-fullscreen`, `anchor-not-in-context`,
`no-transcript-view`, `no-markers`, `marker-not-found`, `error:<name>`.

## Tests

```bash
node test.mjs
```

`transcript.test.mjs` (run by `test.mjs`) drives the real extension against a started
`TuiAltScreen` behind pi's renderer proxy, pi's chat viewport, and pi's real message
components at several terminal widths.
