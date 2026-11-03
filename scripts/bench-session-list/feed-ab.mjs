#!/usr/bin/env node
// feed-ab: the in-process A/B. For each variant, one at a time: a fresh reflink copy of the
// pristine sessions (.tmp/bench-sessions) as <run agent dir>/sessions, then one bun child running
// feed.ts against that variant's source tree. Results: .tmp/bench-<label>.json.
//
//   node scripts/bench-session-list/feed-ab.mjs baseline=.tmp/baseline-src partA=. [--sessions .tmp/bench-sessions]
//        [any feed.ts option: --idle 180 --load 180 --warmup 30 --cool 20 --busy 4 --seed 42]
//   node scripts/bench-session-list/run.mjs --compare .tmp/bench-baseline.json .tmp/bench-partA.json

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const args = process.argv.slice(2);
const variants = args.filter((a) => /^[\w-]+=/.test(a)).map((a) => { const [label, src] = a.split("="); return { label, src: resolve(ROOT, src) }; });
const rest = [];
let sessions = join(ROOT, ".tmp", "bench-sessions");
for (let i = 0; i < args.length; i++) {
  if (/^[\w-]+=/.test(args[i])) continue;
  if (args[i] === "--sessions") { sessions = resolve(args[++i]); continue; }
  rest.push(args[i]);
}
if (!variants.length) { console.error("usage: feed-ab.mjs <label>=<source tree> ... [feed.ts options]"); process.exit(2); }
if (!existsSync(sessions)) { console.error(`no pristine sessions copy at ${sessions}`); process.exit(2); }
if (resolve(sessions).startsWith(join(homedir(), ".pi") + "/")) { console.error("refusing to run on ~/.pi"); process.exit(2); }

const count = (dir) => readdirSync(dir, { withFileTypes: true, recursive: true }).filter((e) => e.isFile() && e.name.endsWith(".jsonl")).length;
for (const v of variants) {
  if (!existsSync(join(v.src, "server", "sessions-index.ts"))) { console.error(`${v.label}: no server/sessions-index.ts under ${v.src}`); process.exit(2); }
  const agent = join(ROOT, ".tmp", `run-${v.label}-agent`);
  rmSync(agent, { recursive: true, force: true });
  mkdirSync(agent, { recursive: true });
  execFileSync("cp", ["-a", "--reflink=auto", sessions, join(agent, "sessions")]);
  const n = count(join(agent, "sessions")), want = count(sessions);
  if (n !== want) { console.error(`${v.label}: copied ${n} sessions, expected ${want}`); process.exit(1); }
  const out = join(ROOT, ".tmp", `bench-${v.label}.json`);
  // The code measured: a `git archive` tree names its commit in .bench-commit; a worktree its HEAD
  // (+dirty when server/, shared/ or src/ hold uncommitted edits).
  let commit = "unknown";
  if (existsSync(join(v.src, ".bench-commit"))) commit = readFileSync(join(v.src, ".bench-commit"), "utf8").trim();
  else {
    try {
      commit = execFileSync("git", ["-C", v.src, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
      if (execFileSync("git", ["-C", v.src, "status", "--porcelain", "--", "server", "shared", "src"], { encoding: "utf8" }).trim()) commit += "+dirty";
    } catch {}
  }
  console.log(`== ${v.label}: ${n} sessions, src ${v.src} @ ${commit}`);
  const r = spawnSync("bun", [join(ROOT, "scripts", "bench-session-list", "feed.ts"), "--src", v.src, "--label", v.label, "--out", out, "--commit", commit, ...rest], {
    stdio: "inherit",
    env: { ...process.env, PI_CODING_AGENT_DIR: agent, SOVA_UPDATES_CHECK: "off", SOVA_GIT_MAINTENANCE: "off" },
  });
  if (r.status !== 0) { console.error(`${v.label}: exited ${r.status}`); process.exit(1); }
}
