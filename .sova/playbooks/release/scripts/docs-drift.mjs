#!/usr/bin/env node
// List the Docs pages whose spec sources changed since a release.
// Usage: node docs-drift.mjs --base <rev> [--root <dir>] [--json]
// For each §site.docs/* record at <root>, compares the text of the record and of each claim in its
// `requires` at <base> with <root>, using the trusted spec tools. Reads only the spec. Exits 0.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const base = opt("--base");
const root = resolve(opt("--root") ?? ".");
const json = args.includes("--json");
if (!base) { console.error("usage: docs-drift.mjs --base <rev> [--root <dir>] [--json]"); process.exit(2); }

let core = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi/agent");
if (core === "~" || core.startsWith("~/")) core = homedir() + core.slice(1);
const tool = join(core, "extensions/spec/core/sova-spec.mjs");

const baseRoot = mkdtempSync(join(tmpdir(), "sova-release-base-spec-"));
try {
  execFileSync("sh", ["-c", 'git -C "$1" archive "$2" .sova/spec | tar -x -C "$3"', "sh", root, base, baseRoot]);

  const text = (dir, id) => {
    let out;
    try {
      out = execFileSync("node", [tool, "read", id, "--no-frame", "--whole", "--root", dir, "--json"],
        { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] });
    } catch (e) { out = e.stdout; }
    try {
      const items = JSON.parse(out).items ?? [];
      const own = items.filter((it) => it.id === id);
      return own.length ? own.map((it) => it.text).join("\n") : null;
    } catch { return null; }
  };

  // The records in either layout, through the trusted tools' read-only `records` command.
  const claims = (dir) => {
    let out;
    try { out = execFileSync("node", [tool, "records", "--root", dir, "--json"], { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] }); }
    catch (e) { out = e.stdout; }
    const j = JSON.parse(out);
    if (!j.records) { console.error(`docs-drift: ${tool} records gave no records (${j.findings?.[0]?.message ?? "an older core without the records command?"})`); process.exit(2); }
    const c = j.records;
    return Object.entries(c).map(([id, v]) => ({ id, ...v }));
  };
  const docs = claims(root).filter((r) => r.id.startsWith("§site.docs/") && (r.code ?? []).some((p) => p.startsWith("site/src/content/docs/")));

  const cache = new Map();
  const changed = (id) => {
    if (!cache.has(id)) {
      const before = text(baseRoot, id), after = text(root, id);
      cache.set(id, before === after ? null : before === null ? "new" : after === null ? "removed" : "changed");
    }
    return cache.get(id);
  };

  const pages = [];
  for (const r of docs) {
    const sources = [];
    for (const id of [r.id, ...(r.requires ?? [])]) { const how = changed(id); if (how) sources.push({ id, how }); }
    if (sources.length) pages.push({ id: r.id, pages: r.code.filter((p) => p.startsWith("site/src/content/docs/")), sources });
  }

  if (json) console.log(JSON.stringify({ base, root, checked: docs.length, pages }, null, 2));
  else {
    console.log(`${pages.length} of ${docs.length} Docs pages have spec sources changed since ${base}`);
    for (const p of pages) {
      console.log(`\n${p.pages.join(", ")}  (${p.id})`);
      for (const s of p.sources) console.log(`  ${s.how.padEnd(7)} ${s.id}`);
    }
  }
} finally {
  rmSync(baseRoot, { recursive: true, force: true });
}
process.exit(0);
