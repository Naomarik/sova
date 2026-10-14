// Run: pnpm test -- server/chat-runtime/gc-timer.test.ts. Bun's GC timer, off in chat processes
// (server/chat-runtime/gc-timer.ts): the chat deletes the variable from its own environment, and the
// pinned Bun still knows the name. When a Bun upgrade drops it, the canary fails: remove the setting
// (chatEnv, main.ts, gc-timer.ts) or move to what replaced it.
import assert from "node:assert/strict";
import { openSync, readSync, closeSync } from "node:fs";
import { test } from "node:test";
import { dropGcTimerEnv, GC_TIMER_OFF } from "./gc-timer";

const isBun = typeof (process.versions as Record<string, string | undefined>).bun === "string";

test("a chat process drops the variable from its own environment, and only that one", () => {
  const env: NodeJS.ProcessEnv = { [GC_TIMER_OFF.name]: GC_TIMER_OFF.value, LANG: "C", BUN_GC_TIMER_INTERVAL: "1000" };
  dropGcTimerEnv(env);
  assert.deepEqual(env, { LANG: "C", BUN_GC_TIMER_INTERVAL: "1000" });
});

test("canary: the pinned Bun's binary still names the variable", { skip: isBun ? false : "a Bun canary (pnpm test runs Bun)" }, () => {
  const needle = Buffer.from(GC_TIMER_OFF.name);
  const fd = openSync(process.execPath, "r");
  try {
    const buf = Buffer.alloc(1 << 20);
    let carry = Buffer.alloc(0);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      const window = Buffer.concat([carry, buf.subarray(0, n)]);
      if (window.includes(needle)) return;
      carry = window.subarray(Math.max(0, window.length - needle.length + 1));
    }
  } finally {
    closeSync(fd);
  }
  assert.fail(`${process.execPath} no longer names ${GC_TIMER_OFF.name}`);
});
