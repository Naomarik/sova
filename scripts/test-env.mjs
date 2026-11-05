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
