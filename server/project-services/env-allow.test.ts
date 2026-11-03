import assert from "node:assert/strict";
import { test } from "node:test";
import { inheritedEnv } from "./env-allow";

test("a project's processes inherit the XDG homes and mise's settings, never a secret or a chat's variable", () => {
  const env = inheritedEnv({
    PATH: "/bin",
    HOME: "/h",
    XDG_STATE_HOME: "/ws/state",
    XDG_DATA_HOME: "/ws/data",
    XDG_CONFIG_HOME: "/ws/config",
    XDG_CACHE_HOME: "/ws/cache",
    MISE_STATE_DIR: "/ws/mise-state",
    MISE_DATA_DIR: "/ws/mise-data",
    MISE_GITHUB_TOKEN: "secret",
    MISE_API_KEY: "secret",
    ANTHROPIC_API_KEY: "secret",
    CLAUDE_CONFIG_DIR: "/c",
    SOVA_CHAT_UNIT: "u",
    GIT_DIR: "/g",
  });
  assert.deepEqual(env, {
    PATH: "/bin",
    HOME: "/h",
    XDG_STATE_HOME: "/ws/state",
    XDG_DATA_HOME: "/ws/data",
    XDG_CONFIG_HOME: "/ws/config",
    XDG_CACHE_HOME: "/ws/cache",
    MISE_STATE_DIR: "/ws/mise-state",
    MISE_DATA_DIR: "/ws/mise-data",
    LANG: "C.UTF-8",
  });
  assert.equal(inheritedEnv({ PI_CODING_AGENT_DIR: "/a" }, ["PI_CODING_AGENT_DIR"]).PI_CODING_AGENT_DIR, "/a");
});
