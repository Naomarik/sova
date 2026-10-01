#!/usr/bin/env node
// probe.mjs — drive an isolated headless Chromium over raw CDP and measure one window of sidebar
// churn. No requestAnimationFrame loops are injected; every observer is installed once.
//
// Usage: node probe.mjs --url http://127.0.0.1:<port> [--window 30] [--warmup 10] [--skills <dir>]
//
// It starts its own browser with the playwright skill's start-browser.sh (never attaches to
// another), navigates at 1600x1000, waits for the list, warms up, then over the window measures:
//   - row and group survival, by tagging every `details.session-group li` / `details.session-group`
//     with a JS property and counting how many are still connected at the end;
//   - long tasks (PerformanceObserver 'longtask', installed once, guarded by a window flag);
//   - nodes added/removed per second (one MutationObserver, installed once);
//   - Performance.getMetrics Nodes/JSEventListeners, before and after HeapProfiler.collectGarbage.
//
// It prints one JSON summary and a PASS/FAIL line (FAIL if fewer than 95% of rows survive, or the
// window's long-task total is over 300 ms), and always stops its browser (stop-browser.sh).

import { spawn } from "node:child_process";
import { join, resolve } from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
const url = args.get("url");
if (!url) {
  console.error("usage: probe.mjs --url http://127.0.0.1:<port> [--window 30] [--warmup 10] [--skills <dir>]");
  process.exit(2);
}
const windowSec = Number(args.get("window") ?? 30);
const warmupSec = Number(args.get("warmup") ?? 10);
const skills = resolve(args.get("skills") ?? join(import.meta.dirname, "..", "..", ".claude", "skills", "playwright", "scripts"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run a command to completion, returning { code, stdout, stderr }. */
function run(cmd, argv, env) {
  return new Promise((res) => {
    const child = spawn(cmd, argv, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => res({ code, stdout, stderr }));
  });
}

/** Minimal CDP client over Node's global WebSocket (one page target). */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.next = 1;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id === undefined) return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`CDP ${msg.error.message}`));
      else p.resolve(msg.result);
    });
  }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", () => rej(new Error("CDP websocket failed")), { once: true });
    });
    return new CDP(ws);
  }
  send(method, params = {}) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "evaluate threw");
    return r.result.value;
  }
  async metrics() {
    const r = await this.send("Performance.getMetrics");
    const out = {};
    for (const m of r.metrics) out[m.name] = m.value;
    return { Nodes: out.Nodes ?? null, JSEventListeners: out.JSEventListeners ?? null };
  }
  close() {
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }
}

const RESET_AND_TAG = `(() => {
  const P = window.__perfLoad || (window.__perfLoad = { installed: false, longtasks: [], muts: [] });
  if (!P.installed) {
    P.installed = true;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) P.longtasks.push({ t: e.startTime, d: e.duration });
    }).observe({ type: "longtask", buffered: false });
    // Count every ELEMENT added or removed under document.body: a replaced subtree's descendants
    // are lost with their root, so an added/removed node counts itself and all elements below it.
    const elements = (n) => (n.nodeType === 1 ? 1 + n.querySelectorAll("*").length : 0);
    P.mo = new MutationObserver((recs) => {
      let a = 0, r = 0;
      for (const m of recs) {
        for (const n of m.addedNodes) a += elements(n);
        for (const n of m.removedNodes) r += elements(n);
      }
      if (a || r) P.muts.push({ t: performance.now(), a, r });
    });
    P.mo.observe(document.body, { childList: true, subtree: true });
  }
  P.winStart = performance.now();
  P.rows = [...document.querySelectorAll("details.session-group li")];
  P.groups = [...document.querySelectorAll("details.session-group")];
  return { rows: P.rows.length, groups: P.groups.length, width: innerWidth };
})()`;

const END = `(() => {
  const P = window.__perfLoad;
  const elapsed = (performance.now() - P.winStart) / 1000;
  const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : null);
  const rowsAlive = P.rows.filter((e) => e.isConnected).length;
  const groupsAlive = P.groups.filter((e) => e.isConnected).length;
  const lt = P.longtasks.filter((e) => e.t >= P.winStart);
  const muts = P.muts.filter((m) => m.t >= P.winStart);
  let added = 0, removed = 0, records = 0;
  const perSecond = [];
  for (const m of muts) {
    added += m.a; removed += m.r; records++;
    const i = Math.floor((m.t - P.winStart) / 1000);
    if (!perSecond[i]) perSecond[i] = { added: 0, removed: 0 };
    perSecond[i].added += m.a;
    perSecond[i].removed += m.r;
  }
  return {
    elapsed,
    rows: { start: P.rows.length, alive: rowsAlive, survivalPct: pct(rowsAlive, P.rows.length) },
    groups: { start: P.groups.length, alive: groupsAlive, survivalPct: pct(groupsAlive, P.groups.length) },
    longTasks: { count: lt.length, totalMs: Math.round(lt.reduce((s, e) => s + e.d, 0)), maxMs: Math.round(lt.reduce((s, e) => Math.max(s, e.d), 0)) },
    nodes: { added, removed, records, perSecond },
  };
})()`;

let browserPort = null;
let cdp = null;
function stopBrowser() {
  if (browserPort === null) return;
  try {
    spawn(join(skills, "stop-browser.sh"), [], { env: { ...process.env, PW_PORT: String(browserPort) }, stdio: "ignore" }).unref();
  } catch {
    // best effort
  }
  browserPort = null;
}

try {
  const started = await run(join(skills, "start-browser.sh"), ["--headless"], {});
  if (started.code !== 0) throw new Error(`start-browser.sh failed: ${started.stderr || started.stdout}`);
  const m = started.stdout.match(/PW_PORT=(\d+)/);
  if (!m) throw new Error(`no PW_PORT in start-browser.sh output: ${started.stdout}`);
  browserPort = Number(m[1]);

  const listUrl = `http://127.0.0.1:${browserPort}/json/list`;
  let targets = await (await fetch(listUrl)).json();
  let target = targets.find((t) => t.type === "page");
  if (!target) {
    const created = await fetch(`http://127.0.0.1:${browserPort}/json/new?about:blank`, { method: "PUT" }).catch(() => null);
    if (!created || !created.ok) throw new Error("could not create a page target");
    target = await created.json();
  }
  cdp = await CDP.connect(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Performance.enable");
  await cdp.send("HeapProfiler.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Page.navigate", { url });

  // Wait for the list to render, then re-assert the viewport (a navigation keeps the override).
  let ready = null;
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    try {
      const probe = await cdp.evaluate(`({ rows: document.querySelectorAll("details.session-group li").length, groups: document.querySelectorAll("details.session-group").length, width: innerWidth })`);
      if (probe.rows > 0) {
        ready = probe;
        break;
      }
    } catch {
      // page still navigating
    }
  }
  if (!ready) throw new Error("sidebar list never rendered");
  if (ready.width !== 1600) {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  }

  await sleep(warmupSec * 1000);
  const start = await cdp.evaluate(RESET_AND_TAG);
  await sleep(windowSec * 1000);
  const end = await cdp.evaluate(END);
  const before = await cdp.metrics();
  await cdp.send("HeapProfiler.collectGarbage");
  await sleep(250);
  const afterGc = await cdp.metrics();

  const pass = (end.rows.survivalPct ?? 0) >= 95 && end.longTasks.totalMs <= 300;
  const summary = {
    url,
    windowSec,
    warmupSec,
    renderedAtStart: start,
    rows: end.rows,
    groups: end.groups,
    longTasks: end.longTasks,
    nodes: end.nodes,
    metrics: { before, afterGc },
  };
  console.log(JSON.stringify(summary));
  console.log(`RESULT: ${pass ? "PASS" : "FAIL"}`);
  stopBrowser();
  process.exit(pass ? 0 : 1);
} catch (err) {
  console.log(JSON.stringify({ url, error: err instanceof Error ? err.message : String(err) }));
  console.log("RESULT: FAIL");
  stopBrowser();
  process.exit(1);
} finally {
  cdp?.close();
}
