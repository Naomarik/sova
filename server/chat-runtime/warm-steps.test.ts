// Run: pnpm test -- server/chat-runtime/warm-steps.test.ts. The chat runtime's warm-up and the start-up
// trail (§app.chat-processes/boot-log): run in-process as the server runs it at its start (no step
// callback), it writes no trail line and arms no beat, so the server logs and sends nothing of a trail;
// a chat process's callback hears Sova's own step names, in order. On a throwaway agent dir: no
// extension of the operator's loads and no model is called.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-warm-steps-"));
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir; // before chat-manager computes its paths

const { getModelRuntime, warmChatRuntime, warmClaudeCodeProvider } = await import("../chat-manager");

/** Every console line and every repeating timer armed while `fn` runs. */
async function watching(fn: () => Promise<void>): Promise<{ lines: string[]; intervals: number[] }> {
  const lines: string[] = [];
  const intervals: number[] = [];
  const was = { log: console.log, warn: console.warn, error: console.error, setInterval: globalThis.setInterval };
  const keep = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  console.log = keep;
  console.warn = keep;
  console.error = keep;
  globalThis.setInterval = ((handler: () => void, ms?: number, ...rest: unknown[]) => {
    intervals.push(ms ?? 0);
    return was.setInterval(handler, ms, ...rest);
  }) as typeof setInterval;
  try {
    await fn();
  } finally {
    Object.assign(console, { log: was.log, warn: was.warn, error: was.error });
    globalThis.setInterval = was.setInterval;
  }
  return { lines, intervals };
}

const TRAIL = /\[chat-runtime\] (ready in|opened in|still starting|still opening|\w+ while (starting|opening))/;

test("the server's own warm-up (no callback) leaves no trail: no trail line, no 10 s beat", async () => {
  const seen = await watching(() => warmChatRuntime());
  assert.deepEqual(
    seen.lines.filter((l) => TRAIL.test(l)),
    [],
  );
  assert.ok(!seen.intervals.includes(10_000), `no beat armed (intervals: ${seen.intervals.join(", ")})`);
});

test("a chat process's callback hears each warm-up step as it begins, in order", async () => {
  // The memoised warm-up already ran above; the provider's own warm-up takes the callback the same way.
  const steps: string[] = [];
  const runtime = await getModelRuntime();
  const seen = await watching(() => warmClaudeCodeProvider(runtime, agentDir, (s) => steps.push(s)));
  assert.deepEqual(steps, ["extensions load", "warm session", "extensions start", "extensions stop"]);
  assert.deepEqual(
    seen.lines.filter((l) => TRAIL.test(l)),
    [],
    "the callback is the only listener: the warm-up itself logs no trail",
  );
});
