// The test runner drops the chat process's own variables it was started with (scripts/test-env.mjs), so tests are
// hermetic whoever runs them, a chat included.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CHAT_ENV, dropChatEnv } from "../scripts/test-env.mjs";
import { CHAT_PROCESS_ENV } from "./chat-runtime/supervisor";

test("every variable a chat process is started with is one the runner drops", () => {
  for (const k of CHAT_PROCESS_ENV) assert.ok(CHAT_ENV.includes(k), k);
});

test("dropChatEnv removes a chat's variables, any SOVA_CHAT_*, and keeps the runner's own slice and code pin", () => {
  const env: Record<string, string> = {
    SOVA_CHAT_UNIT: "sova-chat-x.service",
    SOVA_CHAT_ID: "c1",
    SOVA_CALLER_KEY: "k",
    PI_SESSION_ID: "s",
    SOVA_CHAT_SOMETHING_NEW: "x",
    SOVA_CHAT_SLICE: "sova_test_1_ab.slice",
    SOVA_CHAT_CODE: "live",
    PATH: "/bin",
    SOVA_PORT: "4810",
  };
  const gone = dropChatEnv(env);
  assert.deepEqual(gone.sort(), ["PI_SESSION_ID", "SOVA_CALLER_KEY", "SOVA_CHAT_ID", "SOVA_CHAT_SOMETHING_NEW", "SOVA_CHAT_UNIT"]);
  assert.deepEqual(env, { SOVA_CHAT_SLICE: "sova_test_1_ab.slice", SOVA_CHAT_CODE: "live", PATH: "/bin", SOVA_PORT: "4810" });
  // A chat's own slice is not a test run's: dropped.
  const live = { SOVA_CHAT_SLICE: "sova-chats.slice" };
  dropChatEnv(live);
  assert.deepEqual(live, {});
});
