#!/usr/bin/env node
// sova-scenario: rehearse Sova from the command line. Each scenario boots its own throwaway server
// (server/testing/hermetic-server.ts: a free port, a throwaway agent dir, the scripted stand-in model,
// a sentinel HOME), runs its steps, and tears it all down. Steps drive the server only through
// scripts/sova.mjs, as a person or a script would; this runner never calls a route itself.
//
//   node scripts/sova-scenario.mjs [--json] [--keep] [<file.json | dir>…]   # default: scenarios/
//   pnpm run scenario [<file>…]
//
// No credentials, no network: the only model is the stand-in, on loopback. Exit 0 when every
// scenario passed, 1 when one failed, 2 on a usage problem. --json prints one result per scenario
// (its boot time and each step's time, for later gates); --keep keeps each scratch dir.
//
// A scenario is { "name", "about"?, "steps": [ … ] }; each step is one of:
//   { "sova": [args…], "exit"?: 0, "json"?: <match>, "stdout"?: <match>, "stderr"?: <match>, "save"?: "<var>",
//     "until"?: <match>, "timeoutMs"?: 30000, "env"?: { … } }
//       runs `node scripts/sova.mjs <args>`. `exit` is the exit class it must end with (default 0);
//       `json` matches its stdout parsed as JSON, `stdout`/`stderr` the text. `save` keeps the parsed
//       JSON as a variable. `until` re-runs it (every 250 ms) until the exit and `until` both match,
//       or fails at `timeoutMs`. `env` adds to its environment (a wrong SOVA_TOKEN, say).
//   { "watch": "<name>", "events"?: [ … ] }      starts `sova watch` in the background, once it is
//       connected (its first feed frame); `events` limits what an await on it sees
//   { "await": "<name>", "event": <match>, "timeoutMs"?: 20000 }
//       waits until that watch has printed a line matching `event` that no earlier await on it took
//       (so two awaits for one event need it twice); a timeout prints its log. Not a cursor: one list
//       read reports several sessions' events in the list's order, not the order they were caused.
//   { "terminal": "<session path>" }             a pretend terminal holds that session from now on
//       (a live record under the agent dir's sessions/live, owned by this runner's process), as a
//       pi TUI with the file open would; nothing reaches the server but what it reads itself.
//   { "write": "<path>", "json"?: <value>, "text"?: "<text>" }
//       writes a file in the server's agent dir, as a person or an installer would (the extensions
//       manifest, say): `json` as JSON, else `text`. The path is relative to the agent dir, or
//       absolute inside it ({{agent}}/…); a `..` or anything outside it fails the step.
//   { "read": "<path>", "save": "<var>", "timeoutMs"?: 10000 }
//       keeps a file's text, trimmed, as a variable, waiting for it to appear (a key the server
//       writes, say); the same confinement as `write`.
// Every step may have a "name". Strings may hold {{var}} or {{var.key.key}}: a saved value, or
// work (the sessions' folder), base (the server's URL), model (the stand-in's ref) or agent (the
// server's agent dir).
//
// A <match> is a value matched against what was printed:
//   a string, number, boolean or null: equal (a string against text: contained in it);
//   an object: every key it names matches (keys it leaves out are free);
//   an array: as many elements, each matching;
//   { "$match": "<regex>" }   a string the regex finds a match in
//   { "$type": "string" | "number" | "boolean" | "object" | "array" | "null" }
//   { "$some": <match> } / { "$none": <match> }   an array with some element matching / with none
//   { "$absent": true }       the key is not there
//   { "$eq": <value> }        deep equal, nothing left free
//   { "$not": <match> }       anything that doesn't match
//   { "$all": [<match>…] }    every one of them matches
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { STAND_IN_MODEL, startHermeticServer } from "../server/testing/hermetic-server.ts";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = join(ROOT, "scripts", "sova.mjs");

/** Why `actual` doesn't match `want`, or null when it does. `at`: where, for the message. */
export function mismatch(want, actual, at = "$") {
  const show = (v) => (v === undefined ? "nothing" : JSON.stringify(v)?.slice(0, 200));
  if (want && typeof want === "object" && !Array.isArray(want)) {
    const keys = Object.keys(want);
    if (keys.length > 1 && keys.some((k) => k.startsWith("$"))) throw new Error(`a matcher stands alone at ${at} (combine several with $all): ${keys.join(", ")}`);
    const op = keys.length === 1 && keys[0].startsWith("$") ? keys[0] : null;
    if (op === "$match") return typeof actual === "string" && new RegExp(want.$match).test(actual) ? null : `${at}: ${show(actual)} does not match /${want.$match}/`;
    if (op === "$type") {
      const t = actual === null ? "null" : Array.isArray(actual) ? "array" : typeof actual;
      return t === want.$type ? null : `${at}: wanted a ${want.$type}, got ${show(actual)}`;
    }
    if (op === "$some" || op === "$none") {
      if (!Array.isArray(actual)) return `${at}: wanted an array, got ${show(actual)}`;
      const hit = actual.findIndex((x, i) => mismatch(want[op], x, `${at}[${i}]`) === null);
      if (op === "$some") return hit >= 0 ? null : `${at}: no element matches ${show(want.$some)}`;
      return hit < 0 ? null : `${at}[${hit}]: ${show(actual[hit])} matches ${show(want.$none)}`;
    }
    if (op === "$absent") return actual === undefined ? null : `${at}: wanted nothing, got ${show(actual)}`;
    if (op === "$eq") return isDeepStrictEqual(want.$eq, actual) ? null : `${at}: wanted exactly ${show(want.$eq)}, got ${show(actual)}`;
    if (op === "$all") {
      for (const m of want.$all) {
        const why = mismatch(m, actual, at);
        if (why) return why;
      }
      return null;
    }
    if (op === "$not") return mismatch(want.$not, actual, at) === null ? `${at}: ${show(actual)} matches ${show(want.$not)}` : null;
    if (op) throw new Error(`unknown matcher ${op} at ${at}`);
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) return `${at}: wanted an object, got ${show(actual)}`;
    for (const k of keys) {
      const why = mismatch(want[k], actual[k], `${at}.${k}`);
      if (why) return why;
    }
    return null;
  }
  if (Array.isArray(want)) {
    if (!Array.isArray(actual)) return `${at}: wanted an array, got ${show(actual)}`;
    if (actual.length !== want.length) return `${at}: wanted ${want.length} elements, got ${actual.length}`;
    for (let i = 0; i < want.length; i++) {
      const why = mismatch(want[i], actual[i], `${at}[${i}]`);
      if (why) return why;
    }
    return null;
  }
  return want === actual ? null : `${at}: wanted ${show(want)}, got ${show(actual)}`;
}

/** A text output against a match: a plain string is contained, anything else as mismatch(). */
const textMismatch = (want, text, at) => (typeof want === "string" ? (text.includes(want) ? null : `${at}: ${JSON.stringify(text.slice(0, 300))} does not contain ${JSON.stringify(want)}`) : mismatch(want, text, at));

/** `value` with every {{name.key}} in its strings replaced from `vars`. */
export function fill(value, vars) {
  if (typeof value === "string")
    return value.replace(/\{\{([\w.-]+)\}\}/g, (_, ref) => {
      let v = vars;
      for (const k of ref.split(".")) v = v == null ? undefined : v[k];
      if (v === undefined) throw new Error(`{{${ref}}} has no value`);
      return typeof v === "string" ? v : JSON.stringify(v);
    });
  if (Array.isArray(value)) return value.map((v) => fill(v, vars));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, vars)]));
  return value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The CLI's environment: only what it needs, its HOME the sentinel too. */
function cliEnv(server, extra = {}) {
  return { PATH: process.env.PATH ?? "", HOME: server.home, LANG: process.env.LANG ?? "C.UTF-8", SOVA_URL: server.base, SOVA_TOKEN: server.token, PI_CODING_AGENT_DIR: server.agentDir, TMPDIR: process.env.TMPDIR ?? "", ...extra };
}

/** One `node scripts/sova.mjs` run → its exit code, stdout and stderr. */
function sova(server, args, extra) {
  return new Promise((done) => {
    const p = spawn("node", [CLI, ...args], { env: cliEnv(server, extra), cwd: server.work, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => done({ code: code ?? -1, out, err }));
  });
}

/** Why a sova run's result fails its step, or null. */
function judge(step, r) {
  const want = step.exit ?? 0;
  if (r.code !== want) return `exit ${r.code}, wanted ${want}`;
  let json;
  if (step.json !== undefined || step.until !== undefined || step.save !== undefined) {
    try {
      json = JSON.parse(r.out);
    } catch {
      return `stdout is not JSON`;
    }
  }
  if (step.json !== undefined) {
    const why = mismatch(step.json, json);
    if (why) return why;
  }
  if (step.until !== undefined) {
    const why = mismatch(step.until, json);
    if (why) return `until: ${why}`;
  }
  if (step.stdout !== undefined) {
    const why = textMismatch(step.stdout, r.out, "stdout");
    if (why) return why;
  }
  if (step.stderr !== undefined) {
    const why = textMismatch(step.stderr, r.err, "stderr");
    if (why) return why;
  }
  return null;
}

function stepName(step, i) {
  if (step.name) return step.name;
  if (step.sova) return `sova ${step.sova.slice(0, 2).join(" ")}`;
  if (step.watch) return `watch ${step.watch}`;
  if (step.await) return `await ${step.await}`;
  if (step.terminal) return "a terminal holds it";
  if (step.write !== undefined) return `write ${step.write}`;
  if (step.read !== undefined) return `read ${step.read}`;
  return `step ${i + 1}`;
}

/** A watch's log for a failure: every derived event it printed, its feed frames counted (they are noise). */
function watchLog(name, w) {
  const lines = w.out.split("\n").filter(Boolean);
  const events = lines.filter((l) => !l.startsWith('{"event":"feed"'));
  return `  watch ${name} printed ${events.length} event(s) and ${lines.length - events.length} feed frame(s):\n${events.map((l) => `    ${l}`).join("\n") || "    (no events)"}\n  its stderr: ${w.err.trim() || "(nothing)"}`;
}

/** Thrown for a failed step: its message names the step and why. */
export class ScenarioFailure extends Error {}

/** A write or read step's path → the file inside `agentDir` it names, or null when it would reach
    outside it (a `..` segment anywhere, or an absolute path elsewhere). */
export function agentPath(agentDir, p) {
  if (typeof p !== "string" || !p || p.split(/[\\/]+/).includes("..")) return null;
  const root = resolve(agentDir);
  const abs = resolve(root, p);
  return abs.startsWith(root + sep) ? abs : null;
}

/**
 * Runs one scenario on a server of its own. Resolves to { name, ok, bootMs, ms, steps: [{ name, ms, ok }],
 * failure?, homeChanges } and never throws for a failed step. `afterBoot(server)`: a test hook.
 */
export async function runScenario(doc, { keep = false, afterBoot, log = () => {} } = {}) {
  const t0 = performance.now();
  const server = await startHermeticServer({ keep });
  const result = { name: doc.name, ok: false, bootMs: server.bootMs, ms: 0, steps: [], failure: undefined, homeChanges: [] };
  const vars = { work: server.work, base: server.base, model: STAND_IN_MODEL, agent: server.agentDir };
  const watches = new Map();
  const terminals = [];
  let at = "before the first step";
  try {
    if (afterBoot) await afterBoot(server);
    for (const [i, raw] of (doc.steps ?? []).entries()) {
      at = `step ${i + 1} (${raw.name ?? "unnamed"})`;
      const step = fill(raw, vars);
      const name = stepName(step, i);
      at = `step ${i + 1} (${name})`;
      const s0 = performance.now();
      const fail = (why, detail = "") => {
        throw new ScenarioFailure(`step ${i + 1} (${name}): ${why}${detail ? `\n${detail}` : ""}`);
      };
      if (step.sova) {
        const deadline = Date.now() + (step.timeoutMs ?? 30_000);
        let r;
        let why;
        for (;;) {
          r = await sova(server, step.sova, step.env);
          why = judge(step, r);
          if (!why || step.until === undefined || Date.now() > deadline) break;
          await sleep(250);
        }
        if (why) fail(why, `  stdout: ${r.out.slice(0, 1500)}\n  stderr: ${r.err.slice(0, 1500)}`);
        if (step.save) vars[step.save] = JSON.parse(r.out);
      } else if (step.watch) {
        // Unfiltered, so its first feed frame shows it is connected; `events` filters what an await sees.
        const p = spawn("node", [CLI, "watch"], { env: cliEnv(server), cwd: server.work, stdio: ["ignore", "pipe", "pipe"] });
        const w = { p, out: "", err: "", taken: new Set(), events: step.events ? new Set(step.events) : null };
        p.stdout.on("data", (d) => (w.out += d));
        p.stderr.on("data", (d) => (w.err += d));
        watches.set(step.watch, w);
        const ready = Date.now() + 10_000;
        while (!w.out.includes('"event":"feed"') && Date.now() < ready && p.exitCode === null) await sleep(25);
        if (!w.out.includes('"event":"feed"')) fail("sova watch never connected", `  its stderr:\n${w.err || "(nothing)"}`);
      } else if (step.await) {
        const w = watches.get(step.await);
        if (!w) fail(`no watch named ${step.await}`);
        const deadline = Date.now() + (step.timeoutMs ?? 20_000);
        // The first matching line no earlier await on this watch took: each await takes its own
        // line, so two awaits for the same event need two of them.
        const find = () =>
          w.out
            .split("\n")
            .findIndex((l, i) => {
              if (!l || w.taken.has(i)) return false;
              try {
                const ev = JSON.parse(l);
                return (!w.events || w.events.has(ev.event)) && mismatch(step.event, ev) === null;
              } catch {
                return false;
              }
            });
        let hit = find();
        while (hit < 0 && Date.now() < deadline && w.p.exitCode === null) {
          await sleep(100);
          hit = find();
        }
        if (hit < 0) fail(`no event matching ${JSON.stringify(step.event)} within ${step.timeoutMs ?? 20_000} ms`, watchLog(step.await, w));
        w.taken.add(hit);
      } else if (step.terminal) {
        const dir = join(server.agentDir, "sessions", "live");
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `scenario-terminal-${terminals.length}.json`);
        writeFileSync(file, JSON.stringify({ version: 2, session: { pid: process.pid, sessionFile: step.terminal }, heartbeat: Date.now() }));
        terminals.push(file);
      } else if (step.write !== undefined) {
        const file = agentPath(server.agentDir, step.write);
        if (!file) fail(`write: ${JSON.stringify(step.write)} is not inside the agent dir`);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, step.json !== undefined ? JSON.stringify(step.json, null, 2) : String(step.text ?? ""));
      } else if (step.read !== undefined) {
        const file = agentPath(server.agentDir, step.read);
        if (!file) fail(`read: ${JSON.stringify(step.read)} is not inside the agent dir`);
        if (!step.save) fail("read: a read step saves what it read (save)");
        const deadline = Date.now() + (step.timeoutMs ?? 10_000);
        while (!existsSync(file) && Date.now() < deadline) await sleep(100);
        if (!existsSync(file)) fail(`read: ${step.read} did not appear within ${step.timeoutMs ?? 10_000} ms`);
        vars[step.save] = readFileSync(file, "utf8").trim();
      } else fail(`a step needs one of sova, watch, await, terminal, write or read: ${JSON.stringify(raw)}`);
      const ms = Math.round(performance.now() - s0);
      result.steps.push({ name, ms, ok: true });
      log(`  ok   ${String(i + 1).padStart(2)} ${name} (${ms} ms)`);
    }
    result.ok = true;
  } catch (err) {
    // A malformed scenario (an unknown matcher, a {{var}} never saved) fails as its step does.
    result.failure = err instanceof ScenarioFailure ? err.message : `${at}: ${err instanceof Error ? err.message : err}`;
    log(`  FAIL ${result.failure}`);
    const tail = server.log().split("\n").slice(-30).join("\n");
    result.failure += `\n  server log (last lines):\n${tail}`;
  } finally {
    for (const w of watches.values()) w.p.kill();
    for (const f of terminals) rmSync(f, { force: true });
    result.homeChanges = await server.stop();
  }
  if (result.homeChanges.length) {
    result.ok = false;
    result.failure = `${result.failure ? `${result.failure}\n` : ""}the sentinel HOME changed: ${result.homeChanges.slice(0, 20).join(", ")}${result.homeChanges.length > 20 ? ` (+${result.homeChanges.length - 20} more)` : ""}`;
  }
  result.ms = Math.round(performance.now() - t0);
  return result;
}

/** The scenario files a list of paths names: files as given, a folder's *.json sorted. */
export function scenarioFiles(paths) {
  const out = [];
  for (const p of paths.length ? paths : [join(ROOT, "scenarios")]) {
    const abs = resolve(p);
    if (statSync(abs).isDirectory()) for (const f of readdirSync(abs).filter((f) => f.endsWith(".json")).sort()) out.push(join(abs, f));
    else out.push(abs);
  }
  return out;
}

export const loadScenario = (file) => {
  const doc = JSON.parse(readFileSync(file, "utf8"));
  return { ...doc, name: doc.name ?? basename(file, ".json") };
};

async function main(argv) {
  const json = argv.includes("--json");
  const keep = argv.includes("--keep");
  const paths = argv.filter((a) => a !== "--json" && a !== "--keep");
  if (paths.some((a) => a.startsWith("-"))) {
    console.error("usage: node scripts/sova-scenario.mjs [--json] [--keep] [<file.json | dir>…]");
    return 2;
  }
  let files;
  try {
    files = scenarioFiles(paths);
  } catch (err) {
    console.error(`sova-scenario: ${err instanceof Error ? err.message : err}`);
    return 2;
  }
  let failed = 0;
  for (const file of files) {
    const doc = loadScenario(file);
    const say = json ? () => {} : (l) => console.log(l);
    say(`${doc.name}:`);
    const r = await runScenario(doc, { keep, log: say });
    if (!r.ok) failed++;
    if (json) console.log(JSON.stringify(r));
    else console.log(r.ok ? `  passed in ${r.ms} ms (boot ${r.bootMs} ms)` : `  FAILED\n${r.failure}`);
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2)));
