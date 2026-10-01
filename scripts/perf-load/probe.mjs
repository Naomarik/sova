#!/usr/bin/env node
// probe.mjs — drive an isolated headless Chromium over raw CDP and measure one window of sidebar
// churn. No requestAnimationFrame loops are injected; every observer is installed once.
//
// Usage: node probe.mjs --url http://127.0.0.1:<port> [--window 30] [--warmup 10] [--open 6] [--skills <dir>]
//
// It starts its own browser with the playwright skill's start-browser.sh (never attaches to
// another), navigates at 1600x1000, waits for the list, opens the first --open folder sections
// (closed folders hold no rows until first opened), warms up, then over the window measures:
//   - row and group survival, by tagging every `details.session-group li` / `details.session-group`
//     with a JS property and counting how many are still connected at the end;
//   - long tasks (PerformanceObserver 'longtask', installed once, guarded by a window flag), each
//     one's start (ms from the window's start) and duration as well as the totals;
//   - nodes added/removed per second (one MutationObserver, installed once);
//   - Performance.getMetrics Nodes/JSEventListeners, before and after HeapProfiler.collectGarbage.
// With --switch a,b it then checks a session switch: opens A, types in its composer, opens B,
// forces GC, and reports whether A's div.transcript-wrap was released (a WeakRef the page holds),
// the detached div.transcript-wrap trees DOM.getDetachedDomNodes still finds, and the post-GC
// Nodes. A retained transcript fails the run.
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
// Folders start collapsed and build their rows on first open, so the probe opens the first N
// folder sections (Live & web first, in document order) before it measures: survival is over rows
// that exist at the window's start, and those are the opened folders' rows.
const openFolders = Number(args.get("open") ?? 6);
// Two long sessions, "a,b" (run.mjs passes them): the switch check opens A, types in its composer,
// switches to B, forces GC and counts what is left of A's transcript.
const switchPaths = args.get("switch")?.split(",") ?? null;
// The Overseer check (`--overseer <rows in its branch>`, `--overseer-earlier <id>`): see overseerCheck.
const overseerRows = Number(args.get("overseer") ?? 0);
const overseerEarlier = args.get("overseer-earlier") ?? null;
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
    longTasks: {
      count: lt.length,
      totalMs: Math.round(lt.reduce((s, e) => s + e.d, 0)),
      maxMs: Math.round(lt.reduce((s, e) => Math.max(s, e.d), 0)),
      // Each task, for plotting: start in ms from the window's start, and its duration.
      list: lt.map((e) => ({ startMs: Math.round(e.t - P.winStart), durationMs: Math.round(e.d) })),
    },
    nodes: { added, removed, records, perSecond },
  };
})()`;

/** Every element node under a CDP DOM.Node (its returned subtree) whose class names `cls`. */
function countClass(node, cls) {
  if (!node) return 0;
  let n = 0;
  const a = node.attributes ?? [];
  for (let i = 0; i < a.length; i += 2) if (a[i] === "class" && a[i + 1].split(/\s+/).includes(cls)) n++;
  for (const c of node.children ?? []) n += countClass(c, cls);
  for (const c of node.shadowRoots ?? []) n += countClass(c, cls);
  return n;
}

/** Evaluate `expr` until it is truthy, or throw after `ms`. */
async function until(expr, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await cdp.evaluate(expr)) return;
    } catch {
      // navigating
    }
    await sleep(250);
  }
  const seen = await cdp
    .evaluate(`(() => {
      const w = document.querySelector("div.transcript-wrap");
      const ta = document.querySelector("textarea.composer-input");
      return JSON.stringify({ hash: location.hash.slice(0, 60), wrap: !!w, wrapText: w?.textContent.slice(0, 120) ?? null, textarea: ta ? { disabled: ta.disabled } : null, main: document.querySelector("main")?.textContent.slice(0, 200) ?? null });
    })()`)
    .catch(() => "unreadable");
  throw new Error(`timed out waiting for ${what}; on screen: ${seen}`);
}

/** Open A, type in its composer, open B, collect garbage: is A's transcript still alive? */
async function switchCheck([a, b]) {
  const href = (p) => `#/s/${encodeURIComponent(p)}`;
  // The session's title, its first message, is in its head: a capped transcript (about 400 rows
  // built) doesn't build that first row of a 600-row session.
  const shown = (label) => `(() => {
    const w = document.querySelector("div.transcript-wrap");
    return !!w && !!w.querySelector(".thread .entry") && !!document.querySelector("main")?.textContent.includes(${JSON.stringify(label)}) && !!document.querySelector("textarea.composer-input:not([disabled])");
  })()`;
  await cdp.evaluate(`location.hash = ${JSON.stringify(href(a))}`);
  await until(shown("big transcript A"), 60_000, "session A's transcript and composer");
  await sleep(1500);
  const tagged = await cdp.evaluate(`(() => {
    const w = document.querySelector("div.transcript-wrap");
    window.__perfSwitch = { ref: new WeakRef(w) };
    const ta = document.querySelector("textarea.composer-input");
    ta.focus();
    return { elements: w.querySelectorAll("*").length, focused: document.activeElement === ta };
  })()`);
  // Typed the way a user's keys arrive: through the editor, so the browser's own editing state
  // (its undo stack) sees it, not by setting .value.
  for (const word of ["typed ", "by ", "the ", "perf ", "probe"]) {
    await cdp.send("Input.insertText", { text: word });
    await sleep(60);
  }
  const typed = await cdp.evaluate(`document.querySelector("textarea.composer-input")?.value ?? null`);
  await sleep(500);
  await cdp.evaluate(`location.hash = ${JSON.stringify(href(b))}`);
  await until(shown("big transcript B"), 60_000, "session B's transcript and composer");
  await sleep(2000);
  const before = await cdp.metrics();
  for (let i = 0; i < 3; i++) {
    await cdp.send("HeapProfiler.collectGarbage");
    await sleep(300);
  }
  const afterGc = await cdp.metrics();
  const released = await cdp.evaluate(`window.__perfSwitch.ref.deref() === undefined`);
  let detached;
  try {
    await cdp.send("DOM.enable");
    const r = await cdp.send("DOM.getDetachedDomNodes");
    const trees = r.detachedNodes ?? [];
    detached = { trees: trees.length, transcriptWraps: trees.reduce((n, t) => n + countClass(t.treeNode, "transcript-wrap"), 0) };
  } catch (err) {
    detached = { error: err instanceof Error ? err.message : String(err) };
  }
  const pass = released && (detached.transcriptWraps ?? 0) === 0;
  return { a: tagged, typed, released, detached, metrics: { before, afterGc }, pass };
}

/** The Overseer's transcript (`--overseer <rows>`, seeded long by seed.mjs `--overseer-big`), with
    the list churning on: what opening it builds and costs, whether scrolling up and the card jumps
    still work on rows not built, and what its earlier conversation fetches. Each phase starts from
    a fresh page load, so one phase's builds don't help the next. */
async function overseerCheck(rowsInBranch, earlierId) {
  const transcript = `document.querySelector("div.transcript-wrap .transcript")`;
  const entries = `document.querySelectorAll(".thread .entry").length`;
  // Transcript rows over REST (GET /api/transcript?…): the older rows a view fetched. Each is listed
  // by its asking parameters (before/from/tail/chars), so a background prefetch shows as a run of
  // `before` chunks.
  const fetches = `performance.getEntriesByType("resource").filter((r) => new URL(r.name).pathname === "/api/transcript")`;
  const fetchSummary = `(() => { const f = ${fetches}; return { count: f.length, bytes: f.reduce((s, r) => s + (r.encodedBodySize || 0), 0),
    asks: f.map((r) => [...new URL(r.name).searchParams.keys()].filter((k) => k !== "path").join("+")) }; })()`;
  const fresh = async (hash) => {
    await cdp.evaluate(`location.hash = ${JSON.stringify(hash)}`);
    await cdp.send("Page.reload");
    await sleep(500);
    await until(`!!document.querySelector(".thread .entry")`, 60_000, `${hash}'s transcript`);
  };
  // Long tasks from the document's start: each phase reloads the page, and the open's cost starts
  // before any script the probe could evaluate after it.
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__ovLT = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__ovLT.push({ t: e.startTime, d: e.duration }); }).observe({ type: "longtask", buffered: true });`,
  });
  const longTasksSince = (fromExpr, toExpr = "Infinity") => `(() => {
    const from = ${fromExpr}, to = ${toExpr};
    const lt = window.__ovLT.filter((e) => e.t >= from && e.t < to);
    return { count: lt.length, totalMs: Math.round(lt.reduce((s, e) => s + e.d, 0)), maxMs: Math.round(lt.reduce((s, e) => Math.max(s, e.d), 0)),
      list: lt.map((e) => ({ startMs: Math.round(e.t - from), durationMs: Math.round(e.d) })) };
  })()`;
  // The page reloads: the observers RESET_AND_TAG installs go with it.
  const install = () => cdp.evaluate(RESET_AND_TAG);
  const out = { rowsInBranch };

  // A: open (a page load straight onto #/overseer, timed from the document's start), and the 20 s
  // it settles in: rows built over time, long tasks, transcript fetches.
  await cdp.evaluate(`location.hash = "#/overseer"`);
  await cdp.send("Page.reload");
  await sleep(300);
  await until(`!!document.body`, 30_000, "the reloaded page");
  await install();
  await cdp.evaluate(`window.__perfLoad.ovStart = 0`);
  await until(`!!document.querySelector(".thread .entry") && document.querySelector("div.transcript-wrap")?.textContent.includes("Two cards still wait")`, 60_000, "the Overseer's transcript");
  const firstRows = await cdp.evaluate(`({ ms: Math.round(performance.now() - window.__perfLoad.ovStart), entries: ${entries} })`);
  const built = [];
  for (let i = 0; i < 40; i++) {
    built.push(await cdp.evaluate(`({ ms: Math.round(performance.now() - window.__perfLoad.ovStart), entries: ${entries} })`));
    await sleep(500);
  }
  const settle = await cdp.evaluate(longTasksSince("window.__perfLoad.ovStart"));
  const settleFetches = await cdp.evaluate(fetchSummary);
  // Then a window like the list's, with the churn still on.
  await cdp.evaluate(`(window.__perfLoad.ovWin = performance.now(), window.__perfLoad.muts = [], 0)`);
  await sleep(windowSec * 1000);
  const window_ = await cdp.evaluate(longTasksSince("window.__perfLoad.ovWin"));
  const winNodes = await cdp.evaluate(`window.__perfLoad.muts.reduce((s, m) => ({ added: s.added + m.a, removed: s.removed + m.r }), { added: 0, removed: 0 })`);
  const before = await cdp.metrics();
  for (let i = 0; i < 2; i++) {
    await cdp.send("HeapProfiler.collectGarbage");
    await sleep(300);
  }
  const afterGc = await cdp.metrics();
  // Scrolling up: within 2 viewports of the top of the built rows, more are built (or fetched) and
  // the row at the top of the view stays where it was, to the pixel.
  // The row is the first one reaching into the view (ThreadScroller's own spot), read right after
  // the scroll is written and before its scroll event builds anything; then again once the build
  // and the drawing of what it built are over.
  const anchorBefore = await cdp.evaluate(`(() => {
    const root = ${transcript};
    root.scrollTop = Math.round(root.clientHeight * 1.2);
    const top = root.getBoundingClientRect().top;
    const row = [...root.querySelectorAll(".thread > .entry")].find((e) => { const b = e.getBoundingClientRect(); return b.height > 0 && b.bottom > top; });
    window.__perfAnchor = row;
    return { entries: ${entries}, rowId: row?.dataset.entry ?? null, offset: row ? row.getBoundingClientRect().top - top : null, scrollTop: root.scrollTop };
  })()`);
  await sleep(2500);
  const anchorAfter = await cdp.evaluate(`(() => {
    const root = ${transcript}, row = window.__perfAnchor;
    return { entries: ${entries}, offset: row?.isConnected ? row.getBoundingClientRect().top - root.getBoundingClientRect().top : null, scrollTop: root.scrollTop };
  })()`);
  const anchor = {
    before: anchorBefore,
    after: anchorAfter,
    builtMore: anchorAfter.entries - anchorBefore.entries,
    driftPx: anchorBefore.offset === null || anchorAfter.offset === null ? null : Math.round((anchorAfter.offset - anchorBefore.offset) * 10) / 10,
  };
  out.open = { firstRows, built, settle, fetches: settleFetches, window: { ...window_, nodes: winNodes }, metrics: { before, afterGc }, anchor };

  // B: the card chip, then a card reference, to cards whose newest snapshot is far above the tail.
  const inView = (id) => `(() => {
    const el = document.querySelector('[data-card-id="${id}"]');
    if (!el) return null;
    const r = el.getBoundingClientRect(), v = ${transcript}.getBoundingClientRect();
    return r.top < v.bottom && r.bottom > v.top;
  })()`;
  const landed = async (id) => {
    const t0 = Date.now();
    let stable = 0;
    while (Date.now() - t0 < 15_000) {
      if (await cdp.evaluate(inView(id))) {
        if (++stable >= 3) break;
      } else stable = 0;
      await sleep(250);
    }
    return { inView: !!(await cdp.evaluate(inView(id))), ms: Date.now() - t0, entries: await cdp.evaluate(entries) };
  };
  await fresh("#/overseer");
  await sleep(3000);
  const chipOpened = await cdp.evaluate(`(() => { const b = document.querySelector("button.run-status-cards"); b?.click(); return b?.textContent.trim() ?? null; })()`);
  await sleep(300);
  const chipChose = await cdp.evaluate(`(() => { const it = document.querySelector('[aria-label^="c_1:"]'); it?.click(); return !!it; })()`);
  const chip = { chip: chipOpened, chose: chipChose, ...(await landed("c_1")) };
  await fresh("#/overseer");
  await sleep(3000);
  const refClicked = await cdp.evaluate(`(() => { const refs = [...document.querySelectorAll('a[data-card-ref="c_35"]')]; refs.at(-1)?.click(); return refs.length; })()`);
  const ref = { refs: refClicked, ...(await landed("c_35")) };
  out.cards = { chip, ref };

  // C: scrolling to the top in steps, the way a reader would hold Home: everything gets built.
  await fresh("#/overseer");
  await install();
  await cdp.evaluate(`window.__perfLoad.ovTop = performance.now()`);
  let steps = 0;
  let last = -1;
  let still = 0;
  for (; steps < 400; steps++) {
    const s = await cdp.evaluate(`(() => { const root = ${transcript}; root.scrollTop = 0; return { entries: ${entries}, edge: !!document.querySelector(".older-edge") }; })()`);
    if (!s.edge && s.entries === last && ++still >= 4) break;
    if (s.entries !== last) still = 0;
    last = s.entries;
    await sleep(300);
  }
  out.top = {
    steps,
    ms: await cdp.evaluate(`Math.round(performance.now() - window.__perfLoad.ovTop)`),
    entries: await cdp.evaluate(entries),
    longTasks: await cdp.evaluate(longTasksSince("window.__perfLoad.ovTop")),
  };

  // D: the earlier conversation: what it fetches in its first 10 s.
  if (earlierId) {
    await fresh(`#/overseer/h/${encodeURIComponent(earlierId)}`);
    await sleep(10_000);
    out.earlier = { entries: await cdp.evaluate(entries), fetches: await cdp.evaluate(fetchSummary) };
  }
  out.pass =
    firstRows.entries > 0 &&
    built.at(-1).entries <= 600 &&
    chip.inView &&
    ref.inView &&
    anchor.driftPx !== null &&
    Math.abs(anchor.driftPx) < 2 &&
    out.top.entries >= Math.floor(rowsInBranch * 0.98);
  return out;
}

let browserPort = null;
/** Which browser ran: start-browser.sh's binary and its Browser.getVersion. A result is only a
    result about that browser (the switch check passed on Chromium 148 and failed on Chrome 154). */
let browser = null;
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
  const binary = started.stdout.match(/Binary: (.*)/)?.[1]?.trim() ?? null;

  const listUrl = `http://127.0.0.1:${browserPort}/json/list`;
  let targets = await (await fetch(listUrl)).json();
  let target = targets.find((t) => t.type === "page");
  if (!target) {
    const created = await fetch(`http://127.0.0.1:${browserPort}/json/new?about:blank`, { method: "PUT" }).catch(() => null);
    if (!created || !created.ok) throw new Error("could not create a page target");
    target = await created.json();
  }
  cdp = await CDP.connect(target.webSocketDebuggerUrl);
  const version = await cdp.send("Browser.getVersion").catch(() => null);
  browser = { binary, product: version?.product ?? null, userAgent: version?.userAgent ?? null };
  console.error(`[probe] browser: ${browser.product ?? "unknown"} (${binary ?? "unknown binary"})`);
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
      if (probe.groups > 0) {
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

  // Open the first N folders the way a user does, by their summary; the choice is stored, so a
  // folder stays open across the window's polls. Then wait until the opened folders hold rows.
  const opened = await cdp.evaluate(`(() => {
    const closed = [...document.querySelectorAll("details.session-group")].filter((d) => !d.open).slice(0, ${openFolders});
    for (const d of closed) d.querySelector(":scope > summary").click();
    return closed.length;
  })()`);
  for (let i = 0; i < 40; i++) {
    const rows = await cdp.evaluate(`document.querySelectorAll("details.session-group[open] li").length`);
    if (rows > 0 || opened === 0) break;
    await sleep(250);
  }

  await sleep(warmupSec * 1000);
  const start = await cdp.evaluate(RESET_AND_TAG);
  await sleep(windowSec * 1000);
  const end = await cdp.evaluate(END);
  const before = await cdp.metrics();
  await cdp.send("HeapProfiler.collectGarbage");
  await sleep(250);
  const afterGc = await cdp.metrics();

  const listPass = (end.rows.survivalPct ?? 0) >= 95 && end.longTasks.totalMs <= 300;
  const switched = switchPaths ? await switchCheck(switchPaths) : null;
  const overseen = overseerRows > 0 ? await overseerCheck(overseerRows, overseerEarlier) : null;
  const pass = listPass && (switched === null || switched.pass) && (overseen === null || overseen.pass);
  const summary = {
    url,
    browser,
    windowSec,
    warmupSec,
    foldersOpened: opened,
    renderedAtStart: start,
    rows: end.rows,
    groups: end.groups,
    longTasks: end.longTasks,
    nodes: end.nodes,
    metrics: { before, afterGc },
    listPass,
    switch: switched,
    overseer: overseen,
  };
  console.log(JSON.stringify(summary));
  console.log(`RESULT: ${pass ? "PASS" : "FAIL"}`);
  stopBrowser();
  process.exit(pass ? 0 : 1);
} catch (err) {
  console.log(JSON.stringify({ url, browser, error: err instanceof Error ? err.message : String(err) }));
  console.log("RESULT: FAIL");
  stopBrowser();
  process.exit(1);
} finally {
  cdp?.close();
}
