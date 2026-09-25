// Fixture sessions for the parity suite: deterministic JSONL (fixed ids, fixed 2025 timestamps),
// written identically into both sides' agent dirs, so every REST/WS answer about them can be
// compared byte-for-byte once the per-side path prefixes are normalized.
//
// Shapes follow pi 0.87.1's SessionEntry union (dist/core/session-manager.d.ts) and a real
// glm-5.3 chat recorded through the baseline server; the system message is a stub (the real one
// embeds the user's own AGENTS.md, which must never land in this public repository).

import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const T0 = Date.parse("2025-06-01T10:00:00.000Z");
const iso = (min) => new Date(T0 + min * 60_000).toISOString();
const ms = (min) => T0 + min * 60_000;

const usage = (input, output, cacheRead = 0) => ({
  input, output, cacheRead, cacheWrite: 0, reasoning: 0, totalTokens: input + output + cacheRead,
  cost: { input: input * 1.4e-6, output: output * 4.4e-6, cacheRead: cacheRead * 2.6e-7, cacheWrite: 0, total: input * 1.4e-6 + output * 4.4e-6 + cacheRead * 2.6e-7 },
});

/** A chain builder: every entry is parented on the previous one unless `parentId` is given. */
function chain(minuteStart) {
  const entries = [];
  let last = null;
  let minute = minuteStart;
  const add = (id, body, parentId = last) => {
    minute += 1;
    entries.push({ ...body, id, parentId, timestamp: iso(minute) });
    last = id;
    return id;
  };
  return { entries, add, at: () => minute, setLast: (id) => (last = id) };
}

const user = (text, min) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }], timestamp: ms(min) } });
const assistant = (content, min, u = usage(1200, 40, 600)) => ({
  type: "message",
  message: { role: "assistant", content, api: "openai-completions", provider: "zai", model: "glm-5.3", usage: u, stopReason: content.some((b) => b.type === "toolCall") ? "toolUse" : "stop", timestamp: ms(min), responseId: `resp-${min}` },
});
const system = { type: "message", message: { role: "system", content: "", sections: { preamble: "You are a coding assistant (parity fixture stub).", tools: "<tools>\n- read\n- bash\n</tools>" } } };

/** The sessions subdirectory pi derives from a cwd. */
export const sessionsSubdir = (cwd) => `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;

/** name → { id, minute, cwd?: override, lines } */
function fixtureSessions(cwd) {
  const out = [];

  // 1. A real-shaped chat: two turns, one tool call, a topic outline, a session name.
  {
    const id = "01970000-0000-7000-8000-000000000001";
    const c = chain(0);
    c.add("a1000001", { type: "model_change", provider: "zai", modelId: "glm-5.3" });
    c.add("a1000002", { type: "thinking_level_change", thinkingLevel: "low" });
    c.add("a1000003", system);
    const u1 = c.add("a1000004", user("Reply with exactly the single word PONG and nothing else.", 4));
    c.add("a1000005", assistant([{ type: "text", text: "PONG" }], 5, usage(6779, 4, 64)));
    c.add("a1000006", user("Use the bash tool to run `echo parity` and then reply with exactly DONE.", 6));
    c.add("a1000007", assistant([{ type: "toolCall", id: "call_parity_1", name: "bash", arguments: { command: "echo parity", timeout: 30 } }], 7, usage(82, 18, 6784)));
    c.add("a1000008", { type: "message", message: { role: "toolResult", toolCallId: "call_parity_1", toolName: "bash", content: [{ type: "text", text: "parity\n" }], isError: false, timestamp: ms(8) } });
    c.add("a1000009", assistant([{ type: "text", text: "DONE" }], 9, usage(42, 3, 6848)));
    c.add("a1000010", { type: "custom", customType: "topic-outline", data: { version: 2, topics: [{ id: "t1", heading: "PONG response test", anchor: { entryId: u1, role: "user", timestamp: ms(4), fingerprint: "replywithexactlythesinglewordpon" }, summary: ["User requested exactly the word PONG.", "Assistant replied PONG."], at: ms(10) }] } });
    c.add("a1000011", { type: "session_info", name: "Parity: real-shaped chat" });
    out.push({ name: "real-chat", id, minute: 0, cwd, entries: c.entries });
  }

  // 2. Compacted, labelled, with a usage entry and a context edit.
  {
    const id = "01970000-0000-7000-8000-000000000002";
    const c = chain(100);
    c.add("b1000001", { type: "model_change", provider: "zai", modelId: "glm-5.3" });
    c.add("b1000002", user("Explain what a mesh network is.", 102));
    c.add("b1000003", assistant([{ type: "thinking", thinking: "Short answer." }, { type: "text", text: "A mesh is a network where nodes connect **directly** to each other.\n\n```ts\nconst peers = new Map<string, Peer>();\n```" }], 103));
    c.add("b1000004", { type: "usage", kind: "cache_warm", provider: "zai", model: "glm-5.3", usage: usage(10, 0, 5000) });
    c.add("b1000005", user("And tailnets?", 105));
    c.add("b1000006", assistant([{ type: "text", text: "A tailnet is a private WireGuard mesh coordinated by a control server." }], 106));
    c.add("b1000007", { type: "label", targetId: "b1000006", label: "tailnet answer" });
    c.add("b1000008", { type: "compaction", summary: "User asked about meshes and tailnets; both were explained.", firstKeptEntryId: "b1000005", tokensBefore: 18000 });
    c.add("b1000009", user("Summarize in one line.", 109));
    c.add("b1000010", assistant([{ type: "text", text: "Nodes talk directly; a control plane hands out keys." }], 110, usage(900, 20, 0)));
    c.add("b1000011", { type: "context_edit", targetId: "b1000003", replacement: null });
    out.push({ name: "compacted", id, minute: 100, cwd, entries: c.entries });
  }

  // 3. Branched: a rewind marker moved the leaf back, then a second branch continued.
  {
    const id = "01970000-0000-7000-8000-000000000003";
    const c = chain(200);
    c.add("c1000001", { type: "model_change", provider: "zai", modelId: "glm-5.3" });
    const root = c.add("c1000002", user("First question.", 202));
    const a1 = c.add("c1000003", assistant([{ type: "text", text: "First answer, abandoned branch." }], 203));
    c.add("c1000004", { type: "custom", customType: "sova-rewind", data: { targetId: "c1000001", fromLeafId: a1 } }, "c1000001");
    c.add("c1000005", user("First question, asked again.", 205), "c1000004");
    c.add("c1000006", assistant([{ type: "text", text: "Second answer, on the live branch." }], 206));
    c.add("c1000007", { type: "branch_summary", fromId: root, summary: "An earlier branch answered the first question differently." });
    out.push({ name: "branched", id, minute: 200, cwd, entries: c.entries });
  }

  // 4. A session whose cwd no longer exists (chat refuses with close 4422 "config").
  {
    const id = "01970000-0000-7000-8000-000000000004";
    const c = chain(300);
    c.add("d1000001", { type: "model_change", provider: "zai", modelId: "glm-5.3" });
    c.add("d1000002", user("A session in a folder that was deleted.", 302));
    c.add("d1000003", assistant([{ type: "text", text: "OK." }], 303));
    out.push({ name: "missing-cwd", id, minute: 300, cwd: "/nonexistent/sova-parity-cwd", entries: c.entries });
  }

  // 5. A header-only husk (a webapp session never sent to).
  out.push({ name: "husk", id: "01970000-0000-7000-8000-000000000005", minute: 400, cwd, entries: [] });

  // 6. A worker-like session with a parent reference.
  {
    const id = "01970000-0000-7000-8000-000000000006";
    const c = chain(500);
    c.add("f1000001", { type: "model_change", provider: "deepseek", modelId: "deepseek-flash" });
    c.add("f1000002", user("Plain second model, image-free, with a long title that goes on well past the eighty character cap of the sidebar row.", 502));
    c.add("f1000003", { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Done." }], api: "openai-completions", provider: "deepseek", model: "deepseek-flash", usage: usage(300, 5), stopReason: "stop", timestamp: ms(503) } });
    out.push({ name: "second-model", id, minute: 500, cwd, entries: c.entries });
  }
  return out;
}

/**
 * Write every fixture session under `<agentDir>/sessions`. Returns name → absolute path.
 * Each file's mtime is pinned to its last entry's timestamp: an mtime of "just now" would differ
 * between the two sides by the seeding gap, and would trip the 120 s recent-write guard.
 */
export function seedFixtures(agentDir, cwd) {
  const paths = {};
  for (const f of fixtureSessions(cwd)) {
    const dir = join(agentDir, "sessions", sessionsSubdir(f.cwd));
    mkdirSync(dir, { recursive: true });
    const stamp = iso(f.minute).replace(/[:.]/g, "-");
    const path = join(dir, `${stamp}_${f.id}.jsonl`);
    const header = { type: "session", version: 3, id: f.id, timestamp: iso(f.minute), cwd: f.cwd };
    writeFileSync(path, [header, ...f.entries].map((e) => JSON.stringify(e)).join("\n") + "\n");
    const last = new Date(f.entries.at(-1)?.timestamp ?? header.timestamp);
    utimesSync(path, last, last);
    paths[f.name] = path;
  }
  return paths;
}
