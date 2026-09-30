#!/usr/bin/env node
// Micro-benchmarks for the statecharts bundle (numbers go into statecharts/SPIKE.md).
//
//   node statecharts/bench/bench.mjs [bundle.js]      default: ../out/lib/statecharts.js
//
// Cold load: a fresh `node` per sample, timing only the dynamic import of the shipped module. Per event:
// the probe statechart, registered at runtime from its JS copy (server/fixtures/statecharts-engine/probe-statechart.ts,
// loaded with Node's type stripping; its guards and scripts are JS, so these rows include their
// marshalling), warmed up, then N sends per case (median of 5 rounds, µs per call).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = resolve(process.argv[2] ?? join(here, "..", "out", "lib", "statecharts.js"));
if (!existsSync(bundle)) throw new Error(`no bundle at ${bundle}`);
const url = pathToFileURL(bundle).href;
const probeStatechartUrl = pathToFileURL(join(here, "..", "..", "server", "fixtures", "statecharts-engine", "probe-statechart.ts")).href;
const { PROBE_STATECHARTS } = await import(probeStatechartUrl);

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

function coldLoad(samples = 15) {
  const probe = `const t=performance.now();await import(${JSON.stringify(url)});` +
    `const l=performance.now()-t;const m=await import(${JSON.stringify(url)});` +
    `const {PROBE_STATECHARTS}=await import(${JSON.stringify(probeStatechartUrl)});` +
    `const t2=performance.now();const e=m.createEngine({statecharts:PROBE_STATECHARTS});e.start("p","engine-probe",{}, {now:1});` +
    `console.log(JSON.stringify({load:l,firstStart:performance.now()-t2}))`;
  const loads = [], starts = [];
  for (let i = 0; i < samples; i++) {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
    const { load, firstStart } = JSON.parse(r.stdout.trim());
    loads.push(load);
    starts.push(firstStart);
  }
  return { importMs: median(loads), firstStartMs: median(starts) };
}

async function perEvent() {
  const m = await import(url);
  const cases = {};
  const time = (name, n, setup, fn) => {
    const rounds = [];
    for (let r = 0; r < 5; r++) {
      const ctx = setup();
      for (let i = 0; i < 200; i++) fn(ctx, i); // warm-up
      const t = performance.now();
      for (let i = 0; i < n; i++) fn(ctx, i);
      rounds.push(((performance.now() - t) * 1000) / n);
    }
    cases[name] = +median(rounds).toFixed(1);
  };
  const eng = (opts = {}) => {
    const e = m.createEngine({ ...opts, statecharts: PROBE_STATECHARTS });
    e.start("p", "engine-probe", { tickMs: 1000 }, { now: 1 });
    return e;
  };
  // A two-state toggle in one region of a 4-region parallel statechart.
  time("send (toggle, no save callback)", 5000, () => eng(), (e, i) => e.send("p", i % 2 ? "gate/close" : "gate/open", {}, { now: 1 }));
  // With a host save callback: every step serializes the full snapshot (EDN text).
  let bytes = 0;
  time("send (toggle, onSave snapshot)", 2000, () => eng({ onSave: (_s, t) => { bytes = t.length; } }),
    (e, i) => e.send("p", i % 2 ? "gate/close" : "gate/open", {}, { now: 1 }));
  // An event whose guard reads the envelope, plus outbox + drain.
  time("send (guarded + outbox)", 5000, () => eng(), (e, i) => e.send("p", i % 2 ? "act/undo" : "act/promote", { level: "L2" }, { now: 1 }));
  // Enter/exit with a delayed send armed and cancelled, deep-history re-entry.
  time("send (hold/resume: history + timer cancel/re-arm)", 3000, () => {
    const e = eng();
    e.send("p", "next", {}, { now: 1 });
    e.send("p", "next", {}, { now: 1 });
    return e;
  }, (e, i) => e.send("p", i % 2 ? "resume" : "hold", {}, { now: 1 }));
  time("trial (refused)", 3000, () => eng(), (e) => e.trial("p", "act/promote", { level: "L1" }, { now: 1 }));
  time("enabledEvents", 2000, () => eng(), (e) => e.enabledEvents("p", { level: "L2" }, { now: 1 }));
  time("dump", 2000, () => eng(), (e) => e.dump("p"));
  const text = eng().dump("p");
  time("load", 2000, () => m.createEngine({ statecharts: PROBE_STATECHARTS }), (e, i) => e.load(`p${i % 50}`, text));
  let workItem = null;
  try {
    const e = m.createEngine();
    e.start("i", "work-item", { itemId: "gap/x", projectSid: "project/o/p" }, { now: 1 });
    time("send work-item facts/changed", 2000, () => {
      const e = m.createEngine();
      e.start("i", "work-item", { itemId: "gap/x", projectSid: "project/o/p" }, { now: 1 });
      return e;
    }, (e, i) => e.send("i", "facts/changed", { batonState: i % 2 ? "open" : "needs-you" }, { now: 1 }));
    workItem = e.dump("i").length;
  } catch (err) {
    workItem = `n/a (${err.message})`;
  }
  return { usPerCall: cases, probeSnapshotBytes: bytes, workItemSnapshotBytes: workItem };
}

const out = { bundle, node: process.version, cold: coldLoad(), ...(await perEvent()) };
console.log(JSON.stringify(out, null, 2));
