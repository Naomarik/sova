// The `large` golden set: one ~10 MB pi session, generated (not committed) so every pnpm test proves the
// goldens stay compact on a real-sized file: per-entry probes sample their targets, large outputs are stored
// as digests (golden.ts). Deterministic: no clock, no randomness beyond a seeded generator.
const T0 = Date.parse("2026-09-04T09:00:00.000Z");

/** mulberry32, so the filler text is the same on every run. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ["parser", "branch", "entry", "reader", "golden", "session", "token", "window", "fork", "rows", "watch", "usage", "context", "tool", "result", "model"];

/** The session's text: ~`turns` turns of user → assistant (thinking, text, tool call) → tool result → reply,
    with an image every 50 turns, a rewound branch, a compaction, custom state and a few 0.86/0.87 lines. */
export function largeSessionText(turns = 900): string {
  const rand = prng(7);
  const words = (n: number) => Array.from({ length: n }, () => WORDS[Math.floor(rand() * WORDS.length)]).join(" ");
  const lines: string[] = [JSON.stringify({ type: "session", version: 3, id: "0190a000-0000-7000-8000-1a7ge0000000", timestamp: new Date(T0).toISOString(), cwd: "/home/user/large" })];
  let n = 0;
  let t = 0;
  let leaf: string | null = null;
  const add = (type: string, body: Record<string, unknown>, parent: string | null = leaf): string => {
    const id = (++n).toString(16).padStart(8, "0");
    const ms = T0 + ++t * 1000;
    const b = body.message ? { ...body, message: { ...(body.message as object), timestamp: ms } } : body;
    lines.push(JSON.stringify({ type, ...b, id, parentId: parent, timestamp: new Date(ms).toISOString() }));
    leaf = id;
    return id;
  };
  const usage = (i: number) => ({ input: 1000 + i, output: 200, cacheRead: 30000 + i * 10, cacheWrite: 500, totalTokens: 31700 + i * 11, cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0, total: 0.0031 } });
  const image = { type: "image", data: "iVBORw0KGgo" + "A".repeat(40_000), mimeType: "image/png" };
  add("model_change", { provider: "zai", modelId: "glm-5.3" });
  add("thinking_level_change", { thinkingLevel: "high" });
  add("custom", { customType: "mode", data: { mode: "code", active: { major: "code" } } });
  let rewindFrom: string | null = null;
  for (let i = 0; i < turns; i++) {
    const userText = `Turn ${i}: ${words(30)}`;
    const u = add("message", { message: { role: "user", content: i % 50 === 7 ? [{ type: "text", text: userText }, image] : [{ type: "text", text: userText }] } });
    if (i === 300) rewindFrom = u;
    add("message", {
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: words(60), thinkingSignature: "sig" }, { type: "text", text: words(80) }, { type: "toolCall", id: `call_${i}`, name: i % 3 ? "read" : "bash", arguments: i % 3 ? { path: `src/f${i}.ts` } : { command: `rg ${WORDS[i % WORDS.length]}` } }],
        api: "openai-completions",
        provider: "zai",
        model: "glm-5.3",
        usage: usage(i),
        stopReason: "toolUse",
      },
    });
    add("message", { message: { role: "toolResult", toolCallId: `call_${i}`, toolName: i % 3 ? "read" : "bash", content: [{ type: "text", text: words(1100) }], isError: i % 97 === 5 } });
    add("message", { message: { role: "assistant", content: [{ type: "text", text: words(120) }], api: "openai-completions", provider: "zai", model: "glm-5.3", usage: usage(i), stopReason: i % 113 === 9 ? "error" : "stop", ...(i % 113 === 9 ? { errorMessage: "503 overloaded" } : {}) } });
    if (i % 40 === 20) add("custom", { customType: "topic-outline", data: { version: 2, now: `Working on turn ${i}`, overall: "A large golden session", state: "fresh", generatedAt: T0 + t * 1000, topics: [{ id: "t1", heading: "Large", summary: [words(8)], at: T0 }] } });
    if (i === 450) add("compaction", { summary: `## Summary\n${words(200)}`, firstKeptEntryId: u, tokensBefore: 150000, details: { readFiles: ["a.ts"], modifiedFiles: [] } });
    if (i % 100 === 60) add("usage", { kind: "cache_warm", provider: "zai", model: "glm-5.3", usage: usage(0) });
    if (i % 100 === 61) add("context_edit", { targetId: u, replacement: null });
  }
  // A rewind back to turn 300's input, then two more turns on the new branch.
  const target = rewindFrom!;
  const back = lines.map((l) => JSON.parse(l)).find((e) => e.id === target).parentId as string;
  const from = leaf;
  add("custom", { customType: "sova-rewind", data: { targetId: target, fromLeafId: from } }, back);
  for (let i = 0; i < 2; i++) {
    add("message", { message: { role: "user", content: [{ type: "text", text: `After the rewind ${i}: ${words(20)}` }] } });
    add("message", { message: { role: "assistant", content: [{ type: "text", text: words(50) }], api: "openai-completions", provider: "zai", model: "glm-5.3", usage: usage(i), stopReason: "stop" } });
  }
  return `${lines.join("\n")}\n`;
}
