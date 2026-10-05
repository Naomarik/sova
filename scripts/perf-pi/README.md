# perf-pi — Sova before and after a pi upgrade

An A/B harness for everything a pi version can change in Sova: server cold start, hosted runtime open,
turn latency by session length, steer and follow-up, memory per runtime, the model registry, compaction,
and the `pi --mode rpc` startup a subagent worker pays. It compares two trees that differ in their pi
(first used for pi 0.87.1 → 1.0.3: `docs/perf/2026-10-06-pi-1.0.md`). Builtins only, no network, no
auth, nothing written to `~/.pi` or to either tree.

## Rerun

```sh
# 1. Two clean trees, each with its own install (never `git worktree add`; ~/.cache may be a private
#    mount in a sandboxed session, so keep them under this worktree's .agent/):
git archive <base-rev>  | tar -x -C .agent/perf-base   # then, in each: mise trust <dir>; pnpm install --frozen-lockfile
git archive <after-rev> | tar -x -C .agent/perf-after

# 2. The pi CLIs for metric 8, in scratch npm prefixes (never `npm -g`):
mkdir -p .agent/pi-cli/1.0.3 && (cd .agent/pi-cli/1.0.3 && echo '{"private":true}' > package.json \
  && npm install --no-audit --no-fund --ignore-scripts @earendil-works/pi-coding-agent@1.0.3)
#    same for 0.87.0 (the install-layout control). The base CLI is the global pi (`--cli-global <pkg dir>`).

# 3. Data and agent dirs (once): a sample of real sessions copied in from ~/.pi/agent/sessions
#    (read only), synthesized sessions of 50/500/2000/5000 entries, and one hermetic agent dir per
#    side (each tree's own scripts/hermetic-agent-dir.mjs) with the mock model in its models.json.
node scripts/perf-pi/run.mjs --prepare --base .agent/perf-base --after .agent/perf-after

# 4. A/A first (the same tree on both sides): each metric's own noise floor.
node scripts/perf-pi/run.mjs --base .agent/perf-base --after .agent/perf-base --rounds 6 \
  --out docs/perf/data/pi-1.0/aa

# 5. The A/B run (about 100 s a round): rounds alternate base/after order to cancel drift.
node scripts/perf-pi/run.mjs --base .agent/perf-base --after .agent/perf-after --rounds 10 \
  --out docs/perf/data/pi-1.0/ab --aa docs/perf/data/pi-1.0/aa --label-base 16ca9baf --label-after <rev>

# Tables again from the saved samples:
node scripts/perf-pi/run.mjs --summarize docs/perf/data/pi-1.0/ab --aa docs/perf/data/pi-1.0/aa
```

Options: `--phases server,cli`, `--turns 5` (turns per session length per run), `--steers 3`,
`--chunks 8 --gap 15` (the mock's reply: 8 deltas 15 ms apart), `--max-load <load1>` (wait, up to
`--max-wait-min 20`, before a round while the machine is busier than that), `--work <dir>` (default
`.agent/perf-pi`), `--port-base 4870 --port-after 4871 --mock-port 4879`, `--sessions <dir>` (the real
sessions to sample, default `~/.pi/agent/sessions`), `--cli-dir`, `--cli-global`,
`--cli-after-version 1.0.3`, `--cli-base-version 0.87.0`.

Check the ports are free first (`ss -ltn | grep -E ':487[0-9]\b'`); the harness never kills anything
it did not start.

## What runs

- **Servers**: each tree's `scripts/start-server.sh` (Bun, the `dev:hermetic` entry), one at a time,
  with `PI_CODING_AGENT_DIR` = a fresh copy of that side's agent dir template every run, `HOME` and
  `CLAUDE_CONFIG_DIR` under `.agent/perf-pi/<side>/home`, a fake `claude` (`scripts/fake-claude.mjs`)
  first on `PATH`, `PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1`, `PI_TELEMETRY=0`, `SOVA_PRICES_FETCH=off`.
- **Model**: `mock-llm.mjs`, a loopback OpenAI-compatible endpoint (the pattern of
  `scripts/harness-wire-e2e-mock-llm.mjs`, registered like `server/harness/pi/testing/scripted-model.ts`'s
  `scriptedModelsJson`) as `perfmock/mock-1` and `mock-2`. pi's real openai-completions provider talks
  to it, so a turn exercises pi end to end; the in-process ScriptedModel can't reach a separate server
  process. It logs each request's arrival, so "prompt → model request" isolates pi's request build.
- **Sessions**: real ones copied in with their header's `cwd` moved to `.agent/perf-pi/cwd/real` (a
  runtime never runs in a real project); synthesized ones (`sessions.mjs`, the shapes of
  `server/harness/pi/golden/fixtures/large.ts`) recorded on the mock model.
- **Per server run** (`serverRun`): cold start to `/api/health`, RSS after 10 s idle, `/api/models`,
  the controls, 10 runtime opens with RSS at 1/5/10 (the first open pays module and extension load),
  opens by size, 5 turns at each of 50/500/2000/5000 entries, 3 steer + follow-up rounds mid-stream,
  set_model there and back three times, one compaction, RSS at the end.
- **pi CLI** (`cliRound`): `node <pkg>/dist/cli.js --mode rpc --model perfmock/mock-1 [--no-extensions]
  --session-dir …` → the first `get_state` answer, as `pi-config/extensions/subagents/runner.ts` waits
  for readiness; base = the global pi, after = the scratch 1.0.3; the control compares the global
  0.87.0 with a scratch 0.87.0.
- Round 0 is a warm-up, recorded nowhere (Bun's transpiler cache, Node's compile cache, jiti's).

## Output

`<out>/samples.jsonl` (every sample: metric, side, round, value), `runs.jsonl` (per run: load average
and cpu PSI before and after, pi version, errors), `meta.json` (machine, trees, options, session sizes),
`run.log`, `summary.md` / `summary.json`. Server logs stay in `.agent/perf-pi/logs/`. Paths written
under docs/ are repo-relative or `~/`-relative (`scripts/perf/paths.mjs`).

How a change is judged: per metric, the median of the per-round medians on each side; paired by
round, an exact sign test; "beyond noise" when p < 0.05 and |Δ%| exceeds the metric's A/A |Δ%| (at
least 3%). See `stats.mjs`.
