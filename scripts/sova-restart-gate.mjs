#!/usr/bin/env node
// The restart gate of an adopted unit (§app.project-services/adopt): `apply` on an adopted slot 0
// schedules this script with `systemd-run --user --on-active=30s`, outside the server; on macOS the
// server starts it in a session of its own with `--delay 30`, and it waits that long itself. When it
// fires it reads the scheduling server's live records again (CLAUDE.md "Live server restart": a
// record of that server's pid, heartbeat at most 30 s old, with a working subagent or a turn in
// flight) and only then restarts the unit (`systemctl --user restart`; on macOS the launchd agent
// labelled with the unit's name without `.service`, by `launchctl kickstart -k gui/<uid>/<label>`):
//
//   node scripts/sova-restart-gate.mjs [--delay <seconds>] --unit <name.service> --server-pid <pid> \
//     --live-dir <dir> [--main-pid <the unit's main pid when scheduled>] [--log <file>]
//
// Exit 0: restarted, or restarted already since the schedule (its main pid changed), so nothing to
// do. Exit 75: a hosted session is busy, nothing restarted. Exit 1: systemctl (launchctl) failed.
// Exit 2: bad arguments. Every outcome is one line in the log (and on stdout, the unit's journal).

import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BUSY_EXIT = 75;
/** As server/live.ts WORKING_FRESH_MS. */
const FRESH_MS = 30_000;

/** `--key value` pairs; null when one is missing its value or unknown. */
export function parseArgs(argv) {
  const known = ["--unit", "--server-pid", "--live-dir", "--main-pid", "--log", "--delay"];
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    const v = argv[i + 1];
    if (!known.includes(k) || v === undefined) return null;
    out[k.slice(2)] = v;
  }
  if (!out.unit || !/^[A-Za-z0-9@._:-]+\.service$/.test(out.unit) || !/^\d+$/.test(out["server-pid"] ?? "") || !out["live-dir"]) return null;
  if (out["main-pid"] !== undefined && !/^\d+$/.test(out["main-pid"])) return null;
  if (out.delay !== undefined && !/^\d+$/.test(out.delay)) return null;
  return out;
}

const count = (v) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0);

/** Why `serverPid`'s hosted sessions are busy ("1 with working subagents, 1 turn in flight"), or null (pure, for tests). */
export function busyOf(records, serverPid, now) {
  let workers = 0;
  let turns = 0;
  for (const rec of records) {
    if (rec?.session?.pid !== serverPid) continue;
    const beat = typeof rec.heartbeat === "number" ? rec.heartbeat : 0;
    if (now - beat > FRESH_MS) continue;
    if (count(rec.presence?.workerCounts?.working) > 0) workers++;
    else if (rec.presence?.activity?.state === "working") turns++;
  }
  if (!workers && !turns) return null;
  return [...(workers ? [`${workers} with working subagents`] : []), ...(turns ? [`${turns} with a turn in flight`] : [])].join(", ");
}

/** Every live record in `dir` (dotfiles are writers' temp files; a torn one is skipped). */
export function readRecords(dir) {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    if (!n.endsWith(".json") || n.startsWith(".")) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir, n), "utf8")));
    } catch {
      // partially written
    }
  }
  return out;
}

const realExec = (file, args) =>
  new Promise((done) =>
    execFile(file, args, { timeout: 120_000 }, (err, stdout, stderr) =>
      done({ code: err ? (typeof err.code === "number" ? err.code : 127) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }),
    ),
  );

/** `launchctl print`'s own `pid = N` line (one tab in), or undefined (pure, for tests). */
export const launchdPidOf = (text) => /^\tpid = (\d+)$/m.exec(text)?.[1];

/** How this host's service manager reads and restarts `unit`: systemd, or launchd on macOS. */
export function managerOf(unit, platform = process.platform, uid = process.getuid?.() ?? 0) {
  if (platform !== "darwin")
    return { name: "systemctl", show: ["systemctl", ["--user", "show", unit, "--property=MainPID"]], pidOf: (out) => /^MainPID=(\d+)/m.exec(out)?.[1], restart: ["systemctl", ["--user", "restart", unit]] };
  const target = `gui/${uid}/${unit.replace(/\.service$/, "")}`;
  return { name: "launchctl", show: ["launchctl", ["print", target]], pidOf: launchdPidOf, restart: ["launchctl", ["kickstart", "-k", target]] };
}

/** One firing: returns the exit code; `exec`, `records`, `now`, `say`, `sleep` and `platform` are the tests' seams. */
export async function gate(opts, { exec = realExec, records = readRecords, now = Date.now, say = console.log, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), platform = process.platform, uid } = {}) {
  const m = managerOf(opts.unit, platform, uid);
  const log = (line) => {
    const text = `${new Date(now()).toISOString()} ${opts.unit}: ${line}`;
    say(text);
    if (opts.log)
      try {
        mkdirSync(dirname(opts.log), { recursive: true });
        appendFileSync(opts.log, `${text}\n`);
      } catch {
        // the journal still has it
      }
  };
  if (opts.delay !== undefined) await sleep(Number(opts.delay) * 1000);
  if (opts["main-pid"] !== undefined) {
    const show = await exec(...m.show);
    const pid = m.pidOf(show.stdout);
    if (show.code === 0 && pid !== undefined && pid !== "0" && pid !== opts["main-pid"]) {
      log(`restarted already since the schedule (main pid ${opts["main-pid"]} → ${pid}): nothing to do`);
      return 0;
    }
  }
  const busy = busyOf(records(opts["live-dir"]), Number(opts["server-pid"]), now());
  if (busy) {
    log(`restart deferred (exit ${BUSY_EXIT}): hosted sessions of server pid ${opts["server-pid"]} are busy: ${busy}; nothing restarted, apply again once they are idle`);
    return BUSY_EXIT;
  }
  const r = await exec(...m.restart);
  if (r.code !== 0) {
    log(`restart failed: ${(r.stderr || r.stdout).trim() || `${m.name} exited with ${r.code}`}`);
    return 1;
  }
  log("restarted");
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts) {
    console.error("usage: sova-restart-gate.mjs [--delay <seconds>] --unit <name.service> --server-pid <pid> --live-dir <dir> [--main-pid <pid>] [--log <file>]");
    process.exit(2);
  }
  process.exit(await gate(opts));
}
