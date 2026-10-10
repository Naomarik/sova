// Lane B1 measurement (read-only over pi and Claude Code session logs): not a test.
// Tally the causes in real "[spec census] incomplete: <why>;" notes delivered as tool results / hook context.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
const roots = [process.env.HOME + "/.pi/agent/sessions", process.env.HOME + "/.claude/projects"];
const since = Date.parse(process.argv[2] ?? "2026-10-06");
const tally = new Map(), sess = new Map(), ctx = new Map();
function walk(d) { for (const n of readdirSync(d)) { const p = join(d, n); let s; try { s = statSync(p); } catch { continue; } if (s.isDirectory()) walk(p); else if (n.endsWith(".jsonl") && s.mtimeMs > since) scan(p); } }
function scan(p) {
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.includes("[spec census] incomplete: ")) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    const m = e.message ?? {};
    const isPi = m.role === "toolResult";
    const isCc = e.type === "attachment" || line.includes("hook_additional_context") || line.includes("additionalContext");
    if (!isPi && !isCc) continue;
    if (Date.parse(e.timestamp ?? 0) < since) continue;
    for (const x of line.matchAll(/\[spec census\] incomplete: ([^;\\]{1,160});/g)) {
      if (x[1].includes("<why>") || x[1].includes("…")) continue;
      tally.set(x[1], (tally.get(x[1]) ?? 0) + 1);
      if (!sess.has(x[1])) sess.set(x[1], new Set());
      sess.get(x[1]).add(p);
      if (!ctx.has(x[1])) ctx.set(x[1], []);
      ctx.get(x[1]).push(`${e.timestamp} ${isPi ? "pi" : "cc"} ${p.split("/").slice(-2).join("/")}`);
    }
  }
}
for (const r of roots) try { walk(r); } catch {}
for (const [k, v] of [...tally].sort((a, b) => b[1] - a[1])) console.log(v, "notes", sess.get(k).size, "sessions:", k);
if (process.argv[3]) for (const [k, list] of ctx) { console.log("\n#", k); for (const l of list) console.log("  " + l); }
