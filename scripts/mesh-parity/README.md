# mesh-parity

Checks that a `mesh` commit with no peer configured behaves exactly like the master baseline
(`--base <rev>`: master's tip `5e0ff37` since the master merge `eea59e5`; `6444a04`, the branch point,
through M5). Each base is extracted to its own `~/.cache/sova-mesh/baseline-<sha7>`.

```
node scripts/mesh-parity/parity.mjs                  # baseline vs HEAD of branch `mesh`
node scripts/mesh-parity/parity.mjs --mesh <rev>     # vs any commit
node scripts/mesh-parity/parity.mjs --aa             # baseline vs itself: must be green (noise floor)
node scripts/mesh-parity/parity.mjs --patch x.diff   # patch the mesh tree (seeded-failure canaries)
node scripts/mesh-parity/parity.mjs --only rest,watch --expect-mesh-ui home-desktop=1,settings=1
```

- Both trees come from `git archive` (baseline in `~/.cache/sova-mesh/baseline`, mesh in
  `~/.cache/sova-mesh/qa-reviewer/trees/<sha>`), never from a worktree, and are installed from the
  frozen lockfile. Only COMMITTED code is tested, and a verdict names its commit.
- The two sides run one after the other at the SAME paths (agent dir, HOME, TMPDIR, fixture cwd,
  port), so almost nothing needs normalizing. Each side gets its own hermetic agent dir built by
  that tree's `scripts/hermetic-agent-dir.mjs`, the API-key-only `auth.json` (the run refuses any
  other key set), a fake HOME (the usage fetcher otherwise reads the real `~/.pi`, `~/.claude`,
  `~/.codex` credentials) and a PATH without the user's CLIs.
- Phases: `static` (build, typecheck, `pnpm test`: no new failing test), `rest` (every baseline
  route — a coverage check fails the run if a server route is never requested — on fixed fixture
  sessions, mutations included, plus an echo extension through the extension proxy), `watch` (WS
  watch on every fixture, the error close codes, the extension WS proxy's close-code mirroring),
  `screens` (the playwright skill's browser; `[data-mesh-ui]` nodes are counted against the expected
  count and removed, the rest must match pixel for pixel within antialiasing tolerance and by
  innerText), `chat` (scripted two-turn glm-5.3 chat), `proc` (strace + ss: binds, listening
  sockets, connection kinds per phase, execs, any tailscale path or 100.64/10 packet, idle wakeups),
  `disk` (every file left in the agent dir and HOME, `auth.json` byte-identical, fixture cwd clean).
- What is normalized, and why each rule cannot hide a real change, is in `normalize.mjs` and
  `wsphase.mjs` (`chatShape`). Every rule there was forced by a measured A/A difference.
- A known, accepted difference goes in `allowed-diffs.json` (`[{ "check": "<regex>", "reason": "…" }]`)
  with its reason; anything else fails. Reports: `~/.cache/sova-mesh/qa-reviewer/runs/<stamp>/report.md`.
