import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer as createHttp } from "node:http";
import { createServer as createTcp } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { tourScriptFixture } from "../../shared/tour-fixtures";
import { discoverTourBrowser, launchTourBrowser } from "./browser";
import { runTourAttempt } from "./runner";
import { startRunnerProxy } from "./runner-proxy";
import { TourCaptureFailure } from "./targets";
import type { TourRecordingContext } from "./sandbox";

// G5: speculative connections (preconnect, DNS prefetch, speculation-rules prefetch) open sockets
// without a routable request, so the recorder's per-request consent and address checks never see
// them. With the sandbox off, the recorder's browser must make none: a listener on another loopback
// port counts TCP connections. Positive control: a plain Chromium launch (no recorder flags) on the
// same page does connect, so 0 means "no speculative contact", not "the page never asked".
// One hint per page. A case whose plain-launch control makes no contact on this build cannot
// discriminate: the recorder still runs and any contact of its fails, then the case reports a skip,
// never a pass (seen so far for preconnect, dns-prefetch with its IP-literal origin, prerender and
// the anchor). Their switches stay on as a precaution; with the sandbox off the attempt's own proxy
// is the guarantee for every connection.
type Hint = "prefetch" | "header-rules" | "injected-rules" | "anchor" | "preconnect" | "dns-prefetch" | "prerender" | "icon";
async function fixture(kind: Hint) {
  // Each connection to the other port, with what it was: an HTTP request line (a fetched prefetch,
  // prerender or icon) or a bare connect that never sent a byte (a preconnect).
  let other = 0;
  const contacts: string[] = [];
  const tcp = createTcp(socket => {
    other++;
    let seen = false;
    const done = (what: string) => { if (seen) return; seen = true; contacts.push(what); socket.destroy(); };
    socket.once("data", (b: Buffer) => done(`request: ${b.toString("latin1").split("\r\n")[0]!.slice(0, 120)} (purpose: ${/^sec-purpose: *(.*)$/im.exec(b.toString("latin1"))?.[1] ?? /^purpose: *(.*)$/im.exec(b.toString("latin1"))?.[1] ?? "-"})`));
    socket.once("close", () => done("bare connect, closed without a byte"));
    setTimeout(() => done("bare connect, no byte within 1.5 s"), 1500);
  });
  tcp.listen(0, "127.0.0.1"); await once(tcp, "listening");
  const otherOrigin = `http://127.0.0.1:${(tcp.address() as { port: number }).port}`;
  const rules = JSON.stringify({ prefetch: [{ source: "list", urls: [`${otherOrigin}/next`] }] });
  const head = {
    // Declared in the markup.
    prefetch: `<script type="speculationrules">${rules}</script>`,
    // Declared by a Speculation-Rules response header naming a same-origin rules file (served below).
    "header-rules": "",
    // Injected by a script after load.
    "injected-rules": `<script>addEventListener("load", () => { const s = document.createElement("script"); s.type = "speculationrules"; s.textContent = ${JSON.stringify(rules)}; document.head.append(s); });</script>`,
    icon: `<link rel="icon" href="${otherOrigin}/i.ico">`,
    anchor: "",
    preconnect: `<link rel="preconnect" href="${otherOrigin}">`,
    "dns-prefetch": `<link rel="dns-prefetch" href="${otherOrigin}">`,
    prerender: `<script type="speculationrules">${JSON.stringify({ prerender: [{ source: "list", urls: [`${otherOrigin}/next`] }] })}</script>`,
  }[kind];
  // Only the anchor case links to the other origin (anchor-based navigation prediction may connect).
  const html = `<!doctype html><html><head>${head}</head><body><main><h1>Saved drafts</h1><p>Made-up page with one ${kind} hint at another origin.</p>${kind === "anchor" ? `<a href="${otherOrigin}/next">Next</a>` : ""}</main></body></html>`;
  let pages = 0;
  const http = createHttp((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path === "/rules.json") { res.setHeader("content-type", "application/speculationrules+json"); res.end(rules); return; }
    if (path === "/drafts") pages++;
    if (kind === "header-rules") res.setHeader("speculation-rules", '"/rules.json"');
    res.setHeader("content-type", "text/html"); res.end(html);
  });
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  const origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  return {
    origin, otherOrigin, other: () => other, contacts: () => [...contacts], pages: () => pages, reset: () => { other = 0; pages = 0; contacts.length = 0; },
    close: async () => { http.closeAllConnections(); await new Promise<void>(d => http.close(() => d())); await new Promise<void>(d => tcp.close(() => d())); },
  };
}

for (const hint of ["prefetch", "header-rules", "injected-rules", "anchor", "preconnect", "dns-prefetch", "prerender"] as const) test(`G5 ${hint}: the recorder's browser makes no speculative contact; a plain launch on the same page does`, { timeout: 120_000 }, async t => {
  const f = await fixture(hint);
  const root = mkdtempSync(join(tmpdir(), "tour-prediction-"));
  try {
    // Positive control: an ordinary headless Chromium (none of the recorder's flags) contacts the
    // other origin for this hint alone. If it never does, this hint can't discriminate here: say so.
    const plain = await chromium.launch({ executablePath: discoverTourBrowser(), headless: true });
    try {
      const page = await (await plain.newContext()).newPage();
      await page.goto(`${f.origin}/drafts`);
      for (let i = 0; i < 40 && f.other() === 0; i++) await new Promise(ok => setTimeout(ok, 100));
      await new Promise(ok => setTimeout(ok, 1600));
    } finally { await plain.close(); }
    const control = f.contacts();
    const discriminates = f.other() > 0;
    f.reset();
    const context: TourRecordingContext = { sessionId: "prediction", sessionFile: join(root, "chat.jsonl"), cwd: root, agentDir: join(root, "agent"), sandbox: { on: false } };
    const script = tourScriptFixture();
    script.source = { kind: "site", origin: f.origin };
    // Consent as in production: only the page's own origin is approved. A speculative request the
    // recorder's route sees is refused before contact (asked lists it); what no route sees can only
    // show up at the other port.
    const asked: string[] = [];
    const consent = async (origin: string) => { asked.push(origin); if (origin !== f.origin) throw new TourCaptureFailure({ message: "This site needs approval.", guidance: "Approve it, then retry.", blockedOrigin: origin }); };
    // The attempt's own proxy, logging what it was asked: an origin it refused never got a dial.
    const decisions: string[] = [];
    const startProxy: typeof startRunnerProxy = o => startRunnerProxy({ ...o, onDecision: d => decisions.push(`${d.method} ${d.origin} ${d.allowed ? "admitted" : "refused"}`) });
    const outcome = await runTourAttempt({ context, script, tourId: "prediction", editionId: "prediction-edition", dryRun: true, beforeContact: consent, startProxy }).then(() => "ok", (e: unknown) => e);
    await new Promise(ok => setTimeout(ok, 2000));
    const report = `${hint}: plain launch ${JSON.stringify(control)}; recorder ${JSON.stringify(f.contacts())}; consent asked for ${JSON.stringify([...new Set(asked)])}; proxy ${JSON.stringify([...new Set(decisions)])}; outcome ${outcome === "ok" ? "ok" : String((outcome as Error)?.message)}`;
    console.log(`[G5] ${report}`);
    assert.ok(f.pages() >= 1, `the recorder loaded the page (${report})`);
    if (outcome !== "ok") assert.ok(outcome instanceof TourCaptureFailure && outcome.failure.blockedOrigin === f.otherOrigin, `the attempt succeeds or refuses the hinted origin (${report})`);
    assert.equal(f.other(), 0, `no speculative contact reached the other port (${report})`);
    // The proxy admitted nothing but the approved page's origin (the browser's own background calls
    // included), and the approved page itself went through it (positive control for the proxy path).
    assert.deepEqual([...new Set(decisions.filter(d => d.endsWith(" admitted")).map(d => d.split(" ")[1]))], [f.origin], `only the approved origin was admitted (${report})`);
    assert.ok(decisions.some(d => d.endsWith(`${f.origin} admitted`)), `the page's own origin was admitted by the proxy (${report})`);
    // Only the positive control turns into a skip, after every recorder assertion held.
    if (!discriminates) { const why = `[G5] ${hint}: cannot discriminate on this build (plain launch made no contact)`; console.log(why); t.skip(why); }
  } finally { await f.close(); rmSync(root, { recursive: true, force: true }); }
});

test("G5: the recorder's browser keeps Playwright's disabled features and adds its own in ONE switch", { timeout: 60_000 }, async () => {
  const commandLine = async (browser: import("playwright-core").Browser) => {
    const cdp = await browser.newBrowserCDPSession();
    const { arguments: argv } = await cdp.send("Browser.getBrowserCommandLine") as { arguments: string[] };
    return argv.filter(a => a.startsWith("--disable-features=")).map(a => a.slice("--disable-features=".length).split(","));
  };
  // Playwright's own list, from a plain launch of the same browser (HttpsUpgrades among them: an
  // http origin never silently becomes an unapproved :443).
  const plain = await chromium.launch({ executablePath: discoverTourBrowser(), headless: true });
  let defaults: string[];
  try { const lists = await commandLine(plain); assert.equal(lists.length, 1); defaults = lists[0]!; } finally { await plain.close(); }
  assert.ok(defaults.includes("HttpsUpgrades"), "control: the plain launch carries Playwright's list");
  const browser = await launchTourBrowser();
  try {
    const switches = await commandLine(browser);
    // Chromium keeps only one of duplicated switches, so a second one would drop the other's list.
    assert.equal(switches.length, 1, `exactly one --disable-features switch: ${switches.map(l => l.join(",")).join(" | ")}`);
    const features = switches[0]!;
    for (const f of defaults) assert.ok(features.includes(f), `keeps Playwright's ${f}`);
    // The recorder's own.
    for (const f of ["NetworkPrediction", "SpeculationRulesPrefetchProxy", "Prerender2", "PreloadingHeuristics"]) assert.ok(features.includes(f), `adds ${f}`);
  } finally { await browser.close(); }
});

test("G5: a page's icon on another origin is never fetched by the recorder; a plain launch fetches it", { timeout: 120_000 }, async () => {
  const f = await fixture("icon");
  const root = mkdtempSync(join(tmpdir(), "tour-prediction-icon-"));
  try {
    // Positive control: an ordinary headless Chromium fetches the page's icon from the other origin.
    // If it never does, this browser build fetches no icons and the check below cannot discriminate.
    const plain = await chromium.launch({ executablePath: discoverTourBrowser(), headless: true });
    try {
      const page = await (await plain.newContext()).newPage();
      await page.goto(`${f.origin}/drafts`);
      for (let i = 0; i < 40 && f.other() === 0; i++) await new Promise(ok => setTimeout(ok, 100));
    } finally { await plain.close(); }
    assert.ok(f.other() > 0, "positive control: a plain browser fetches the cross-origin icon");
    f.reset();
    const context: TourRecordingContext = { sessionId: "prediction-icon", sessionFile: join(root, "chat.jsonl"), cwd: root, agentDir: join(root, "agent"), sandbox: { on: false } };
    const script = tourScriptFixture();
    script.source = { kind: "site", origin: f.origin };
    // The attempt either succeeds or refuses the icon's own origin; nothing else counts (an attempt
    // that died before the page loaded would also show 0 contacts).
    // Consent as in production: only the page's own origin is approved.
    const consent = async (origin: string) => { if (origin !== f.origin) throw new TourCaptureFailure({ message: "This site needs approval.", guidance: "Approve it, then retry.", blockedOrigin: origin }); };
    const outcome = await runTourAttempt({ context, script, tourId: "prediction-icon", editionId: "prediction-icon-edition", dryRun: true, beforeContact: consent }).then(() => "ok", (e: unknown) => e);
    if (outcome !== "ok") assert.ok(outcome instanceof TourCaptureFailure && outcome.failure.blockedOrigin === f.otherOrigin, `the attempt succeeds or refuses the icon origin: ${String((outcome as Error)?.message)}`);
    assert.ok(f.pages() >= 1, "the recorder loaded the page");
    await new Promise(ok => setTimeout(ok, 1000));
    assert.equal(f.other(), 0, "the unapproved icon origin was never contacted");
  } finally { await f.close(); rmSync(root, { recursive: true, force: true }); }
});
