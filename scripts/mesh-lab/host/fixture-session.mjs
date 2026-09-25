// Seed one fixture session into a lab host's agent dir, so every host lists a session of its own
// from the first boot. Idempotent: does nothing when any session file already exists.
//   node fixture-session.mjs <agentDir> <hostId> <cwd>
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [agentDir, hostId, cwd] = process.argv.slice(2);
const sessions = join(agentDir, "sessions");
mkdirSync(sessions, { recursive: true });
const any = readdirSync(sessions, { recursive: true }).some((f) => String(f).endsWith(".jsonl"));
if (any) process.exit(0);

const dir = join(sessions, `--${cwd.replace(/^\//, "").replace(/[/\\:]/g, "-")}--`);
mkdirSync(dir, { recursive: true });
const t0 = Date.parse("2026-01-01T00:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const id = randomUUID();
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const lines = [
  { type: "session", version: 3, id, timestamp: iso(t0), cwd },
  { type: "message", id: "f0000001", parentId: null, timestamp: iso(t0 + 1000), message: { role: "user", content: `fixture session on lab host ${hostId}`, timestamp: t0 + 1000 } },
  { type: "message", id: "f0000002", parentId: "f0000001", timestamp: iso(t0 + 2000), message: { role: "assistant", content: [{ type: "text", text: `Hello from ${hostId}.` }], api: "openai-completions", provider: "zai", model: "glm-5.3", usage: zero, stopReason: "stop", timestamp: t0 + 2000 } },
];
writeFileSync(join(dir, `${iso(t0).replace(/[:.]/g, "-")}_${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
