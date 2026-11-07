// What a test run never passes on from the shell it was started in: a chat process's own variables (the runner is
// often started from inside a Sova chat). Builtins only; scripts/run-tests.mjs applies it to its own environment
// before anything else, so every test child, on either runtime, starts without them.

/** Exact names: server/chat-runtime/supervisor.ts CHAT_PROCESS_ENV (server/test-env.test.ts holds them equal), a pi
 *  session's own, and a team member's. */
export const CHAT_ENV = [
  "SOVA_CHAT_SOCK",
  "SOVA_CHAT_PATH",
  "SOVA_CHAT_ID",
  "SOVA_CHAT_UNIT",
  "SOVA_CHAT_BUILD",
  "SOVA_CHAT_STATE_ROOT",
  "SOVA_CHAT_LIVE_ROOT",
  "SOVA_CHAT_COPIES_ROOT",
  "SOVA_CALLER_KEY",
  "SOVA_URL",
  "SOVA_CLAUDE_LOGIN_CONTEXT",
  "SOVA_SPEC_LANDED_FILE",
  "SOVA_WAKE_DIR",
  "SOVA_WAKE_WORKER",
  "SOVA_JOBS_DIR",
  "SOVA_JOBS_UNIT_PREFIX",
  "SOVA_JOB_CARDS",
  "SOVA_JOB_CALL",
  "PI_SESSION_ID",
  "PI_SESSION_FILE",
  "PI_SUBAGENTS_TEAM_MEMBER",
  "PI_SUBAGENT_BUILTIN_TOOLS",
];

/** A test runner's own SOVA_CHAT_* variables, which it sets for its children and so keeps: its slice (only one of a
 *  test run's own) and the code generation it pins. */
const keeps = (name, value) => (name === "SOVA_CHAT_SLICE" && /^sova_test_[A-Za-z0-9_]+\.slice$/.test(value ?? "")) || name === "SOVA_CHAT_CODE";

/** Delete every chat-process variable from `env` (the names above, and any other SOVA_CHAT_*); returns the names it removed. */
export function dropChatEnv(env = process.env) {
  const gone = Object.keys(env).filter((k) => (CHAT_ENV.includes(k) || k.startsWith("SOVA_CHAT_")) && !keeps(k, env[k]));
  for (const k of gone) delete env[k];
  return gone;
}

// ─── The test environment: one pinned list ──────────────────────────────────────────────────────────────────────
//
// Every test process starts from this list and nothing else of the shell it was started in, so a chat's run, a
// worker's (sandboxed or not), the Test verb's and the merge queue's give tests the same settings, and a run's
// remembered passes (scripts/test-cache.mjs) are keyed by exactly what tests can see. The runner adds the per-file
// parts (HOME, TMPDIR, the guard's dir, ...) on top; PATH is built, never inherited (testPath).

/** A credential's name (env-allow.ts's test, widened to scripts/test-cache.mjs CREDENTIAL_ENV's): such a name never reaches a
 *  test, whatever list names it. */
export const CREDENTIAL = /TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL|AUTH/i;

/** Inherited as they are, and keyed: who and where (server/project-services/env-allow.ts ENV_ALLOW's run-stable part). */
const BASE = ["USER", "LOGNAME", "LANG", "LC_ALL", "TZ", "SHELL"];

/** The runner's own knobs a test can see: keyed, since a test (or code under it) reads them. */
const KNOBS_KEYED = ["SOVA_RUNTIME", "SOVA_BUN", "SOVA_NODE", "SOVA_TEST_GUARD", "TEST_FILE_LIMIT_MS", "NODE_PASS_LIMIT_MS"];

/** Passed on so a run inside a test behaves like its outer run, never keyed: they change how a run is run (its width,
 *  its slice, its shared lock dir, whether it reuses), not what a test sees of the code. */
export const TEST_ENV_UNKEYED = ["TEST_BUN_JOBS", "TEST_INT_JOBS", "SOVA_CHAT_SLICE", "SOVA_TEST_SHARED_TMP", "SOVA_FRESH", "SOVA_REUSE_SAMPLE"];

/** Switches a test, or the code under it, reads from its environment to run differently (a slow mode, a recording,
 *  a browser, a snapshot rewrite): passed when set, and keyed. A name ending in `*` is a prefix. A switch that rewrites
 *  a tracked file (`*_UPDATE`, `*_OUT`, `WRITE_*_SNAPSHOT`, SOVA_GOLDEN_RECORD, SOVA_MODES_GOLDEN=record) also
 *  changes the work tree, so its run keeps nothing anyway. A new switch goes here, or it never reaches a test. */
export const TEST_SWITCHES = [
  "SOVA_TOUR_BROWSER", "PLAYWRIGHT_BROWSERS_PATH", "SOVA_TEST_SYSTEMD", "ORG_HOST_BENCH", "KILL9_ROUNDS", "SLOW", "LATE",
  "SOVA_LOADOUT_UPDATE", "SOVA_INVENTORY_OUT", "SOVA_SPEC_LAYOUT_ALLOW_OUT", "SOVA_BOUNDARY_OUT", "SOVA_HEADLESS_FILES_OUT",
  "SOVA_GOLDEN_MODE", "SOVA_GOLDEN_RECORD", "SOVA_GOLDEN_REAL_DIR", "SOVA_GOLDEN_SETS", "SOVA_MODES_GOLDEN", "SOVA_MODES_DUMP",
  "SOVA_INSERTION_ALL", "SOVA_INSERTION_DEBUG", "SOVA_STATE_ASSERT", "SOVA_SYNC_LOGIN_KINDS", "SOVA_PARITY_BASE",
  "OWNER_SHOTS", "MQ_UI_SHOTS", "REL_UI_SHOTS", "NY_UI_SHOTS", "CTX_UI_SHOTS", "SPENT_UI_SHOTS", "SPENT_TAB_SHOTS", "MODE_TEST_SCRATCH", "SOVA_TAR_FIXTURES_WRITE",
  "E2E_RELEASE_NOTES", "PI_CLAUDE_CODE_DEBUG", "WRITE_*_SNAPSHOT",
];

/** Switches that point a test at files outside the work tree (a build made elsewhere, another checkout's server):
 *  passed when set, but a run with one set neither reuses nor remembers a pass, since what they name isn't in the
 *  fingerprint. */
export const RECORDS_NOTHING = ["SOVA_*_DIST", "CHAT_TRIAL_ROOT"];

/** Inherited only by the integration tier, never keyed as a value: where the user's service manager is. A unit file
 *  starts no program but git (the tier guard), so it never gets them; a sandboxed shell never has them
 *  (pi-config/extensions/sandbox/env.ts), and an integration run keys whether systemd is reachable instead
 *  (scripts/test-cache.mjs systemdReachable; its keyedEnv leaves the value and TEST_ENV_UNKEYED out of the key). */
const INTEGRATION_ONLY = ["XDG_RUNTIME_DIR"];

const matches = (name, list) => list.some((p) => (p.includes("*") ? new RegExp(`^${p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(name) : p === name));

/** Whether `name` reaches a test of `tier` ("unit" | "integration") when set. */
export function passesToTests(name, tier) {
  if (CREDENTIAL.test(name)) return false;
  return BASE.includes(name) || KNOBS_KEYED.includes(name) || TEST_ENV_UNKEYED.includes(name) || matches(name, TEST_SWITCHES) || matches(name, RECORDS_NOTHING) || (tier === "integration" && INTEGRATION_ONLY.includes(name));
}

/** Whether `name` is one of RECORDS_NOTHING's switches. */
export const matchesRecordsNothing = (name) => !CREDENTIAL.test(name) && matches(name, RECORDS_NOTHING);

/** The directories PATH ends with in every test process, whatever the shell's PATH: the system's. The runner puts the
 *  stand-in `claude`, the real node's directory and mise's tool paths ahead of them (testPath). */
export const SYSTEM_PATH = [
  ...(process.platform === "darwin" ? ["/opt/homebrew/bin", "/opt/homebrew/sbin"] : []),
  "/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin",
];

/** A test process's PATH: `lead` (the stand-in claude's dir, node's dir, mise's tool paths; empty ones dropped), then SYSTEM_PATH. */
export const testPath = (lead, delimiter = ":") => [...lead.flatMap((p) => (p ? String(p).split(delimiter) : [])).filter(Boolean), ...SYSTEM_PATH].filter((p, i, all) => all.indexOf(p) === i).join(delimiter);

/** The part of `source` a test of `tier` inherits: the list above, nothing else (PATH excluded: testPath builds it), and
 *  LANG=C.UTF-8 when it has none. */
export function testEnv(source, tier) {
  const out = {};
  for (const [k, v] of Object.entries(source)) if (v !== undefined && passesToTests(k, tier)) out[k] = v;
  // The default a project's processes get (server/project-services/env-allow.ts inheritedEnv), so a merge check and a
  // chat's shell started from a server with no LANG give tests the same one.
  out.LANG ??= "C.UTF-8";
  return out;
}
