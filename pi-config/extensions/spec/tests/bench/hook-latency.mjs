// Lane B1 measurement (read-only over ~/.claude/projects): not a test.
// For each Claude Code hook run whose output says "census produced no output", how long the hook took:
// the hook attachment's timestamp minus its tool_result's timestamp (and durationMs if recorded).
// A crash returns in milliseconds; a census timeout needs >= 5000 ms.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
const root = process.env.HOME + "/.claude/projects", since = Date.parse(process.argv[2] ?? "2026-10-06");
const rows = [], ok = [];
for (const d of readdirSync(root)) {
  const dir = join(root, d);
  if (!statSync(dir).isDirectory()) continue;
  for (const n of readdirSync(dir)) {
    if (!n.endsWith(".jsonl")) continue;
    const p = join(dir, n);
    if (statSync(p).mtimeMs < since) continue;
    const text = readFileSync(p, "utf8");
    if (!text.includes("hook_success")) continue;
    const resultAt = new Map(), hooks = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      const c = e.message?.content;
      if (Array.isArray(c)) for (const x of c) if (x.type === "tool_result") resultAt.set(x.tool_use_id, Date.parse(e.timestamp));
      const a = e.attachment;
      if (a?.type === "hook_success" && a.hookEvent === "PostToolUse" && String(a.command ?? "").includes("spec-hooks")) hooks.push({ a, at: Date.parse(e.timestamp) });
    }
    for (const { a, at } of hooks) {
      const t0 = resultAt.get(a.toolUseID);
      const row = { session: `${d.slice(-40)}/${n.slice(0, 8)}`, at: new Date(at).toISOString(), lagMs: t0 ? at - t0 : null, durationMs: a.durationMs ?? null };
      if (String(a.stdout).includes("produced no output")) rows.push(row);
      else if (String(a.stdout).includes("[spec census]")) ok.push(row);
    }
  }
}
const q = (xs, p) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] : null; };
const sum = (name, r) => console.log(`${name}: ${r.length} hook runs; lag p50 ${q(r.map((x) => x.lagMs), 0.5)} ms, p95 ${q(r.map((x) => x.lagMs), 0.95)} ms, max ${q(r.map((x) => x.lagMs), 1)} ms; durationMs p50 ${q(r.map((x) => x.durationMs), 0.5)}, max ${q(r.map((x) => x.durationMs), 1)}`);
sum("no-output", rows); sum("census note ok", ok);
if (process.argv[3]) for (const r of rows) console.log(JSON.stringify(r));
