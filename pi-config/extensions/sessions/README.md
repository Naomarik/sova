# Live Pi sessions

Global local extension. Standalone: sessions discover each other through a tiny
filesystem presence bus (`presence.ts`) — every process atomically rewrites
`~/.pi/agent/sessions/live/<id>.json` every few seconds and polls the directory
for peers. No `pi-intercom`, no broker process, no sockets.

## Use

No setup. New sessions load it automatically; run `/reload` in already-open ones.

- **Alt+S** or **`/sessions`**: searchable live-session overlay.
- Type to fuzzy-search session names or working directories.
- **↑/↓**: select; **→/←**: expand/collapse workers.
- **Tab**: latest assistant response / selected worker output preview.
- **Enter**: focus that session's existing window; worker Enter opens its preview.
- **Esc / Ctrl+C**: close without touching the draft or cancelling agent work.
- **Alt+Shift+S** or **`/sessions-back`**: return to the previous session.
- Selection confirm/cancel/navigation respect Pi's injected selection bindings.

The footer counts sessions, running parents, running workers, input prompts, and
unseen completions. Parent activity and background workers are independent.
Live updates preserve row order and selection. Completion markers are local to
this Pi instance and reset on reload. They indicate a run/worker settled, not
that the requested task was successful. Errors remain explicitly labeled.

## Focusing

On this Linux/Ghostty/Hyprland setup the extension adds a small unique `[pi:…]`
tag to the terminal title. It finds the exact visible title and validates the
origin process, start time, TTY, Ghostty ancestor, compositor instance and window
identity before focusing. Titles refresh every five seconds, including renames.
It never resumes a JSONL file, spawns a duplicate session, sends terminal input,
changes your desktop configuration, or focuses windows automatically.

Hidden Ghostty tabs, unsupported terminals/hosts, headless sessions, ambiguous
layouts, and stale/disconnected sessions are **preview-only**. A window containing
a different active tab is not silently switched to. tmux support is deliberately
conservative: exact socket/pane identity, one writable attached client, and an
unambiguous Ghostty/Hyprland host. Herdr and other host adapters are not yet included.

## Presence and privacy

All participating sessions must load this extension. Discovery is limited to
live processes on this machine that write to the shared presence directory;
this is not a saved-history browser (use Pi's `/resume` for that). Records go
stale after 15 heartbeats-less seconds and are unlinked once the pid is dead;
clean shutdown removes the file immediately.

Presence is event-driven with a five-second heartbeat. Rich data expires after
20 seconds; reconnects discard stale snapshots. Idle comes from `agent_settled`,
not `agent_end`, so automatic continuations don't briefly appear idle.

The local bus shares bounded latest **assistant text** (up to 2,000
characters), bounded worker summaries/previews, and roster metadata. It does
not broadcast user prompts, thinking, full tool output, session files, or
messages to the LLM. One opt-out exception: when topic-outline runs with
`shareLastHeading` (default on), the row shows ` · # <heading>` (muted) — the
latest `#` heading you typed in that session (else the newest summarizer topic
heading), capped at 80 characters and control-stripped. It is row-only (not in
the Tab preview), guaranteed visible even on narrow overlays, and hidden for
stale rows. Peers on older builds simply don't send it. Snapshots stay below
12 KiB; at most 40 workers are included, fewer if large Unicode summaries hit
that byte limit. No second daemon or persistent transcript copy.

The installed `subagents/index.ts` publishes authoritative worker snapshots via
`subagents:workers-request` / `subagents:workers-snapshot`, covering both Pi and
Claude backends in that manager. Independent third-party worker managers need
an adapter; generic tool-call inference would not reliably track their jobs.

## Tests

```sh
node ~/.pi/agent/extensions/sessions/test.mjs
```

Uses installed Pi dependencies through Jiti, matching the extension loader.
Focus tests use injected OS/command mocks and never focus your desktop windows.
