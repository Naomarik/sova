---
watches: ["pi-config/extensions/sandbox/**", "pi-config/sandbox-policy/**", "server/sandbox-state.ts", "server/link-sandbox.ts"]
alsoUpdate: ["pi-config/extensions/sandbox/README.md"]
---
# sandbox

`/sandbox on|off`: a per-session OS sandbox for the agent's tools (bubblewrap on Linux, fail closed elsewhere),
with its policy templates in `pi-config/sandbox-policy/`. Sova imports its session entry and its policy resolution.

## What lives here

- [`README.md`](../../../pi-config/extensions/sandbox/README.md). Requirements: §chat/sandbox.
- `pi-config/sandbox-policy/<platform>/` holds the templates (`policy.json` and a `CLAUDE.md`), copied, never
  linked, into the agent dir by `install.sh`.
- Tests: `cd pi-config/extensions/sandbox && node --test tests/*.unit.test.ts tests/unit/*.unit.test.ts && node tests/run.mjs`.
  `naive.mjs` writes its run record to `tests/out/NAIVE-RUN.txt`, gitignored. `tests/FIRST-RUN.txt` is a committed
  record of the first run; nothing rewrites it.

## What Sova relies on

- `state.ts` (builtins only): the `sandbox` session entry and its restore. Its optional `workers: "off"` field makes
  the three states (§chat.sandbox/states); `on` keeps meaning the session's own tools for every reader.
  `server/sandbox-state.ts`, `server/link-sandbox.ts` and `server/chat-manager.ts` import it.
- `policy.ts` (`loadPolicyFile`, `policyFilePath`): the state a new session starts in, for the Overseer's lowering
  check (`server/overseer.ts`).
- `session-policy.ts` and `policy.ts` (builtins only, with their siblings `backend.ts`, `backends/*` and `env.ts`),
  imported by `server/link-sandbox.ts`: `resolveSessionPolicy`, the one resolution of a session's policy from its
  agent dir, cwd, session id and tracked worktrees (the extension's `snapshot()` calls it too), and
  `readDenial` / `writeDenial` / `hiddenBelow`, so a linked session's file transfer is refused exactly where that
  session's own tools would be. `prepareSessionCommand` in that same facade is the whole-command
  launch seam used by the tour recorder: the server supplies trusted effective session scope, runs
  the controller and browser under the returned confined argv/env/fds, reaps them, then disposes
  the private attempt tmp/proxy. Setup failures never fall back to an unconfined browser. Its `proxy`
  option (`forbid`, `local` in `proxy.ts`, off by default, never on the session's own proxy) is how a
  sandbox-on recording refuses non-public DNS answers and reaches its one verified running copy; a
  change to either is a contract change (README).
- The provisional `starting` entry (`SANDBOX_STARTING`, `isStarting` in `state.ts`) is read by
  `server/sandbox-state.ts` (`SandboxInfo.starting`, the shield's "Turning on…") and by the tour
  recorder (`server/tours/context.ts`, which refuses while it is newest). Keep all three on the constant.
- `env.ts`'s `writeGitCleanupConfig` (builtins only), imported by `server/chat-runtime/supervisor.ts`: the git
  system config each chat process gets as `GIT_CONFIG_SYSTEM` (§app.git-cleanup/no-background), the same writer
  the backends use for their own copy in the session tmp (§chat.sandbox/git-cleanup). Its file must never hold an
  `[include]` of its own: the idle git cache turns off for any config that has one.
- The sandbox imports nothing outside its own directory. It asks the server's
  `Symbol.for("sova:tool-command-prefix")` hook for the niceness prefix of tool commands (§app.load-priority/workers);
  unset, as in the TUI, nothing changes.

The dev watcher doesn't watch this directory: an edit reaches a running server only at its restart.

## When you change it, also update

- The entry shape or the policy resolution: the README, and the link transfer's refusals (`server/link-sandbox.ts`
  and its tests).
- A policy template: its `CLAUDE.md` beside it, and `install.sh` if the file set changes
  ([extensions overview](../overview.md)).
