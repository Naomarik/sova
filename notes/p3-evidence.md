# P3 evidence (platform worker) — written to disk because the team relay kept dropping messages

Everything the orchestrator asked for, in one place. Nothing here needs re-running; the servers
have been stopped and playwright uninstalled per the parent's wrap-up instruction.

## Item 1 — dispose the warm-up session: ALREADY FIXED, then fixed again

- `34416a1` added `session.dispose()` after `bindExtensions`.
- `d1be4d7` (the one that matters): a bare `session.dispose()` **skips `session_shutdown`**, so
  extensions that arm a timer at `session_start` fire it against a disposed session. The sessions
  extension's focus-discovery timeout threw `This extension ctx is stale after session replacement
  or reload` as an **unhandledRejection**, at boot and on every toggle-on. The warm-up now emits
  `session_shutdown` first and then disposes, mirroring `AgentSessionRuntime.dispose`
  (`dist/core/agent-session-runtime.js:296`) — the "mirror ChatSession's teardown" that was asked
  for.

### Verification: prompt exit on SIGINT — PASSES

Server started with the toggle ON; warm-up registered 4 `claude-code-cli` models;
`kill -INT` → **process exited in 52 ms** and released port 4810. No handle keeps node alive.

### Verification: no lingering live record — PASSES, but the specified check cannot work

`.agent/sessions/live/` is empty no matter what the code does, because the sessions extension
hardcodes the user's real directory and ignores `PI_CODING_AGENT_DIR`:

- `pi-config/extensions/sessions/presence.ts:76` — `options.dir ?? join(homedir(), ".pi", "agent", "sessions", "live")`
- `pi-config/extensions/sessions/feed.ts:45` — `join(homedir(), ".pi", "agent", "sessions", "live")`

So the check was run against the real directory instead. With the toggle ON, polling
`~/.pi/agent/sessions/live` every 50 ms for 20 s across the whole warm window: **the directory
never changed**, while `/api/models` went to 4. The warm-up publishes no presence record at all,
so there is nothing to leak (presence appears to be gated on TUI mode; the warm-up binds "rpc").
The records present at the time belonged to pids 2407682 and 2796572 — two other pi-web servers,
not this worker's.

**Correction this forces:** "hermetic .agent isolates everything" is NOT true in general. Any
hermetic server that hosts a real chat publishes presence into the user's REAL `~/.pi`, while
`server/live.ts` reads from `getAgentDir()` — written to one place, read from another.
Pre-existing pi-config bug, not introduced by P3; a two-line fix in `presence.ts`/`feed.ts` to
honour `PI_CODING_AGENT_DIR` would close it. Not touched here: shared file, another owner.

## Item 2 — curl evidence (hermetic `.agent`, real claude-code extension, CLI 2.1.278)

```
1. GET /api/settings          (no stored file — the true default)
   {"experimental":{"claudeCodeProvider":false}}

2. GET /api/models            while OFF
   0 claude-code-cli of 7 total

3. PUT /api/settings  {"experimental":{"claudeCodeProvider":true}}
   {"experimental":{"claudeCodeProvider":true}}      (returned in 0.27s, no restart)

4. GET /api/models            while ON — verbatim
   {"ref":"claude-code-cli/claude-fable-5-1[1m]","provider":"claude-code-cli","id":"claude-fable-5-1[1m]","favorite":false,"thinkingLevels":["off","low","medium","high","xhigh","max"],"input":["text","image"]}
   {"ref":"claude-code-cli/opus[1m]","provider":"claude-code-cli","id":"opus[1m]","favorite":false,"thinkingLevels":["off","low","medium","high","xhigh","max"],"input":["text","image"]}
   {"ref":"claude-code-cli/sonnet","provider":"claude-code-cli","id":"sonnet","favorite":false,"thinkingLevels":["off","low","medium","high","xhigh","max"],"input":["text","image"]}
   {"ref":"claude-code-cli/haiku","provider":"claude-code-cli","id":"haiku","favorite":false,"thinkingLevels":["off"],"input":["text","image"]}
   → 4 of 11 total. Prediction confirmed: full ladder on fable/opus/sonnet, ["off"] only on haiku.

5. PUT off, same process, no restart
   GET /api/models → 0 claude-code-cli of 7 total
   GET /api/settings/claude-status → {"version":"2.1.278 (Claude Code)","models":4}
   (unfiltered on purpose: the registration outlives the switch, and the dialog says so)

6. Restart with the switch ON
   GET /api/models → 4 of 11, warmed at boot before any session was opened

7. Bad bodies: {} · {"experimental":null} · {"experimental":{"claudeCodeProvider":"yes"}} · not-json
   → all 400, stored file unchanged
```

## Item 2 — screenshots (captured during the pass, not retained)

The three captures below were taken against a live instance and are described rather than
committed, so this repository ships no screenshots of real sessions.

- Settings → Experimental, toggle OFF, status line
  *"Claude Code CLI 2.1.278 (Claude Code) found. Switch on to add its models."*
- Same tab, toggle ON, status line *"… · 4 models in the picker."*
- A new session's model picker filtered to "claude": `claude-fable-5-1[1m]`, `haiku`, `opus[1m]`,
  `sonnet`, each tagged VISION / claude-code-cli.

No chat turn was run.

## Three defects the browser pass caught (all invisible to typecheck, tests and the bundler)

- `22791a4` **Panel layout.** `.settings-body` is a two-column grid (200px rail + 1fr), so a second
  sibling `.settings-panel` became a third grid item and squeezed the tab into a ~180px strip with
  the toggle floating in dead space. One panel now serves every tab.
- `22791a4` **Lying status line.** Fetched once on tab open and never refetched, so after switching
  on it still read "no models are registered yet — start a session, or restart the server" while
  the server had 4 and the picker listed them. The toggle now refetches it.
- `10fef28` **Dev proxy unreachable.** `vite.config.ts` proxied to `localhost`, which resolves to
  `::1` only on this host while the server binds `127.0.0.1` — so `npm run dev:web` could not reach
  `npm run dev:server` at all; every `/api` and `/ws` call was ECONNREFUSED. Pre-existing.
  `PI_WEB_HOST` overrides.

## Gates (after every commit above)

`npx tsc --noEmit` → 6 errors, exactly the `notes/baseline-red.md` set.
`npm test` → 586 tests, 575 pass, 11 fail, all `src/lib/files.test.ts`, the baseline set (+7 tests
are the new `server/web-settings.test.ts`, all passing).
`npx vite build` → exit 0. `node pi-config/extensions/claude-code/tests/run.mjs` → 226/226.

## Current state

Ports 4810 / 4811 / 5191 all clear — no server of this worker's is running. Browser stopped.
playwright + sharp uninstalled (they had been installed `--no-save`; manifests were never touched)
and the symlink the skill created under `.claude/skills/playwright/scripts/` removed. Note for
whoever does browser work next: **playwright is not present in the main checkout either**, so it
needs a dependency decision first.
