#!/usr/bin/env node
// Regenerates server/harness/pi/golden/fixtures/faux/<scenario>/{session.jsonl,events.json} (G0b): genuine pi
// sessions and event streams from a real AgentSession on pi-ai's faux provider (server/harness/pi/golden/faux/
// record.ts). Explicit only, never part of pnpm test. It runs on Bun in a throwaway HOME (the test runner's
// hermetic preload), so nothing from this machine's home reaches the files.
//
//   node scripts/harness-golden/faux-record.mjs [--out <dir>] [<scenario>…]
//   node scripts/harness-golden/faux-record.mjs --check     # record twice into temp dirs; exit 1 unless identical
//
// PI_PACKAGE_DIR=<a pi-coding-agent dir> records against that pi instead of the pinned one. A re-record that
// changes a committed fixture changes its expected outputs: re-record them and add a CHANGES.md line.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveBun } from "../../server/runtime-choice.ts";

const ROOT = path.join(import.meta.dirname, "../..");
const RECORDER = path.join(ROOT, "server/harness/pi/golden/faux/record.ts");
const PRELOAD = path.join(ROOT, "pi-config/extensions/claude-code/tests/hermetic-env.mjs");

function record(args) {
  const found = resolveBun();
  if (!("path" in found)) {
    console.error(`[faux] bun not found: ${found.missing}`);
    process.exit(2);
  }
  const bun = found.path;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sova-faux-home-"));
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  try {
    const r = spawnSync(bun, ["--preload", PRELOAD, RECORDER, ...args], {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...process.env, HOME: home, SOVA_TEST_HOME: root, TZ: "UTC" },
    });
    return r.status ?? 1;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** Every file under `dir`, relative, sorted. */
const filesIn = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).filter((f) => fs.statSync(path.join(dir, f)).isFile()).sort() : []);

const args = process.argv.slice(2);
if (args.includes("--check")) {
  const rest = args.filter((a) => a !== "--check");
  const a = fs.mkdtempSync(path.join(os.tmpdir(), "sova-faux-a-"));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), "sova-faux-b-"));
  try {
    for (const out of [a, b]) if (record(["--out", out, ...rest]) !== 0) process.exit(1);
    const fa = filesIn(a);
    const diff = [...new Set([...fa, ...filesIn(b)])].filter((f) => !fs.existsSync(path.join(a, f)) || !fs.existsSync(path.join(b, f)) || !fs.readFileSync(path.join(a, f)).equals(fs.readFileSync(path.join(b, f))));
    if (diff.length) {
      console.error(`[faux] two runs differ: ${diff.join(", ")}`);
      process.exit(1);
    }
    console.log(`[faux] two runs byte-identical: ${fa.length} files`);
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
} else process.exit(record(args));
