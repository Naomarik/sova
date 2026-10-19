import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import { tourScriptFixture } from "../../shared/tour-fixtures";
import { normalizeTourScript } from "../../shared/tour";
import { procfsTable } from "../project-services/proctable";
import { runTourAttempt } from "./runner";
import { TourCaptureFailure } from "./targets";
import { killTourChild, spawnTourCommand, type TourRecordingContext } from "./sandbox";
import type { TourChildMessage } from "./runner-protocol";

async function listen(server: Server): Promise<string> { server.listen(0, "127.0.0.1"); await once(server, "listening"); return `http://127.0.0.1:${(server.address() as { port: number }).port}`; }
async function close(server: Server): Promise<void> { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
function setup(origin: string) {
  const root = mkdtempSync(join(tmpdir(), "tour-runner-"));
  const context: TourRecordingContext = { sessionId: "recording-fixture", sessionFile: join(root, "session.jsonl"), cwd: root, agentDir: root, sandbox: { on: false } };
  const script = tourScriptFixture(); script.source = { kind: "site", origin };
  const view = script.steps[0]!.views[0]!; if (view.kind !== "page") throw new Error("fixture"); view.route = "/";
  return { context, script, root };
}
function pngPixel(png: Buffer, x: number, y: number): number[] {
  const width = png.readUInt32BE(16); const channels = png[25] === 6 ? 4 : 3;
  assert.equal(png[24], 8, "8-bit screenshot fixture"); assert.ok([2, 6].includes(png[25]!));
  const chunks: Buffer[] = [];
  for (let i = 8; i < png.length;) { const length = png.readUInt32BE(i); if (png.toString("ascii", i + 4, i + 8) === "IDAT") chunks.push(png.subarray(i + 8, i + 8 + length)); i += length + 12; }
  const raw = inflateSync(Buffer.concat(chunks)); const stride = width * channels;
  let previous = Buffer.alloc(stride);
  for (let row = 0; row <= y; row++) {
    const offset = row * (stride + 1); const filter = raw[offset]!; const current = Buffer.from(raw.subarray(offset + 1, offset + 1 + stride));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? current[i - channels]! : 0; const b = previous[i]!; const c = i >= channels ? previous[i - channels]! : 0;
      const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
      current[i] = (current[i]! + (filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2) : filter === 4 ? pa <= pb && pa <= pc ? a : pb <= pc ? b : c : 0)) & 255;
    }
    previous = current;
  }
  return [...previous.subarray(x * channels, x * channels + 3)];
}
const html = `<!doctype html><html><head><style>body{margin:20px;font:18px sans-serif}#secret{position:absolute;left:20px;top:200px;width:150px;height:40px;background:red}</style></head><body><main><h1>Saved drafts</h1><button type="button" aria-expanded="false" aria-controls="panel" onclick="this.setAttribute('aria-expanded','true');document.getElementById('panel').hidden=false">Details</button><div id="panel" hidden>Made-up draft details</div><form method="post"><label>Draft<input aria-label="Draft" oninput="fetch('/mutate')"></label><button>Send</button></form><div id="secret" data-testid="private-label">Made-up private label</div></main></body></html>`;

test("installed-browser dry run then desktop+phone capture and masked overview; safe local drafts never send", { timeout: 60_000 }, async t => {
  let mutations = 0;
  const server = createServer((req, res) => { if (req.url === "/mutate" || req.method !== "GET") mutations++; res.setHeader("content-type", "text/html"); res.end(html); });
  const origin = await listen(server); const f = setup(origin);
  try {
    const view = f.script.steps[0]!.views[0]!; if (view.kind !== "page") throw new Error("fixture");
    const actions = [{ op: "open" as const, target: { kind: "role" as const, role: "button", name: "Details" } }, { op: "fill" as const, target: { kind: "role" as const, role: "textbox", name: "Draft" }, value: "A local unsent draft" }];
    view.actions = { desktop: actions, phone: actions }; view.masks = [{ kind: "testId", testId: "private-label" }];
    const progress: number[] = [];
    const options = { context: f.context, script: f.script, tourId: "tour-fixture", editionId: "edition-fixture", beforeContact: async (o: string) => { assert.equal(o, origin); }, onProgress: (p: { completed: number }) => progress.push(p.completed) };
    const dry = await runTourAttempt({ ...options, dryRun: true });
    assert.equal(dry.assets.size, 0); assert.equal(dry.contactSheets.length, 0); assert.ok(dry.steps.every(s => s.views.every(v => !Object.keys(v.captures).length)));
    const recorded = await runTourAttempt({ ...options, dryRun: false });
    assert.ok(recorded.metrics && recorded.metrics.wallTimeMs > 0 && recorded.metrics.peakRssBytes > 0);
    assert.equal(recorded.metrics.storedBytes, [...recorded.assets.values()].reduce((n, bytes) => n + bytes.byteLength, 0));
    t.diagnostic(`desktop+phone measured resources: ${JSON.stringify(recorded.metrics)}`);
    assert.equal(recorded.assets.size, 3); assert.equal(recorded.contactSheets.length, 1); assert.equal(progress.at(-1), 2);
    for (const [size, expected] of [["desktop", [1440, 960]], ["phone", [390, 844]]] as const) {
      const capture = recorded.steps[0]!.views[0]!.captures[size]!;
      const bytes = Buffer.from(recorded.assets.get(capture.image)!);
      assert.equal(bytes.readUInt32BE(16), expected[0]); assert.equal(bytes.readUInt32BE(20), expected[1]);
      assert.equal(capture.marks.length, 1);
      assert.deepEqual(pngPixel(bytes, 30, 210), [36, 42, 48], "privacy mask is burned into the PNG, not removable viewer CSS");
    }
    assert.equal(recorded.provenance.origin, origin); assert.deepEqual(recorded.provenance.publicOrigins, []); assert.equal(mutations, 0, "native local fill cannot call autosave or submission handlers");
  } finally { await close(server); rmSync(f.root, { recursive: true, force: true }); }
});

/** Every complete script (a ```json block with steps) in the tour guide's core and its parts, verbatim. */
function guideScripts(): { file: string; raw: Record<string, any> }[] {
  const dir = new URL("../../pi-config/extensions/mode/vis/", import.meta.url);
  const files = readdirSync(dir).filter(f => f === "tour.md" || /^tour-[a-z]+\.md$/.test(f)).sort();
  return files.flatMap(file => [...readFileSync(new URL(file, dir), "utf8").matchAll(/```json\n([\s\S]*?)\n```/g)]
    .map(m => JSON.parse(m[1]!) as Record<string, any>).filter(raw => Array.isArray(raw.steps)).map(raw => ({ file, raw })));
}
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
/** One element a target names, on a made-up page built from the script itself. */
function element(t: { kind: string; role?: string; name?: string; text?: string; testId?: string }, opened: boolean, i: number): string {
  if (t.kind === "text") return `<p>${esc(t.text!)}</p>`;
  if (t.kind === "testId") return `<div data-testid="${esc(t.testId!)}">Made-up ${i}</div>`;
  const name = esc(t.name!);
  if (opened) return `<button type="button" aria-expanded="false" aria-controls="d${i}" onclick="this.setAttribute('aria-expanded','true');document.getElementById('d${i}').hidden=false">${name}</button><section id="d${i}" hidden>Made-up detail</section>`;
  if (t.role === "heading") return `<h2>${name}</h2>`;
  if (t.role === "button") return `<button type="button">${name}</button>`;
  if (t.role === "link") return `<a href="#">${name}</a>`;
  if (t.role === "textbox") return `<form onsubmit="return false"><label>${name} <input type="text"></label></form>`;
  return `<div role="${esc(t.role!)}" aria-label="${name}">${name}</div>`;
}

test("the tour guide's complete scripts run verbatim through dry-run and capture at both sizes", { timeout: 180_000 }, async () => {
  const scripts = guideScripts();
  const core = scripts.filter(s => s.file === "tour.md");
  assert.equal(core.length, 1, "the core guide has one worked example; exercise it, not a retyped copy");
  // The worked example shows what failed in practice (al_9 D1): a sign-in, a reveal before its mark, a mark by role, a reference in three paragraphs.
  const example = core[0]!.raw;
  const pageViews = example.steps.flatMap((s: any) => s.views).filter((v: any) => v.kind === "page");
  assert.ok(example.signIn, "the worked example signs in");
  assert.ok(pageViews.some((v: any) => Object.values(v.actions).some((a: any) => a.some((x: any) => x.op === "reveal"))), "it reveals before a mark");
  assert.ok(pageViews.some((v: any) => v.marks.some((m: any) => m.target.kind === "role")), "a mark is named by role");
  assert.ok(example.steps.flatMap((s: any) => s.views).some((v: any) => v.kind === "reference" && v.reference.split("\n\n").length === 3), "a reference text in three paragraphs");
  for (const { file, raw } of scripts) {
    const signIn = raw.signIn;
    let writes = 0, signInPosts = 0;
    const routes: string[] = [];
    const views = raw.steps.flatMap((s: any) => s.views).filter((v: any) => v.kind === "page");
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      const signedIn = (req.headers.cookie ?? "").includes("sid=made-up");
      const html = (body: string) => { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(`<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font:18px sans-serif}</style></head><body>${body}</body></html>`); };
      const go = (to: string, cookie?: string) => { if (cookie) res.setHeader("set-cookie", cookie); res.statusCode = 302; res.setHeader("location", to); res.end(); };
      if (signIn && url.pathname === new URL(signIn.route, "http://x").pathname) {
        if (req.method === "POST") { signInPosts++; req.resume(); go("/made-up-home", "sid=made-up; Path=/; HttpOnly"); return; }
        if (signedIn) { go("/made-up-home"); return; }
        const box = (t: any, type: string, name: string) => t.kind === "testId" ? `<input type="${type}" name="${name}" data-testid="${esc(t.testId)}">` : `<label>${esc(t.name)} <input type="${type}" name="${name}"></label>`;
        html(`<form method="post" action="${esc(signIn.route)}">${signIn.account ? box(signIn.account, "text", "account") : ""}${box(signIn.username, "text", "username")}${box(signIn.password, "password", "password")}${element(signIn.submit, false, 0).replace('type="button"', 'type="submit"')}</form>`);
        return;
      }
      if (req.method !== "GET") { writes++; res.end(); return; }
      routes.push(url.pathname);
      if (signIn && !signedIn) { go(signIn.route); return; }
      const top = signIn ? element(signIn.signedIn, false, 0) : "";
      // Each view's own targets: the ones it reveals sit far below the first screen, the rest on it.
      const here = views.filter((v: any) => new URL(v.route, "http://x").pathname === url.pathname);
      const seen = new Set<string>(); let up = "", low = "";
      for (const [i, v] of here.entries()) {
        const actions = Object.values(v.actions).flat() as any[];
        const revealed = new Set(actions.filter(a => a.op === "reveal").map(a => JSON.stringify(a.target)));
        const opened = new Set(actions.filter(a => a.op === "open").map(a => JSON.stringify(a.target)));
        for (const [j, t] of [...actions.filter(a => a.target).map(a => a.target), ...v.marks.map((m: any) => m.target), ...v.masks].entries()) {
          const key = JSON.stringify(t);
          if (seen.has(key) || (signIn && key === JSON.stringify(signIn.signedIn))) continue;
          seen.add(key);
          const el = element(t, opened.has(key), i * 100 + j + 1);
          if (revealed.has(key)) low += el; else up += el;
        }
      }
      html(`<nav>${top}</nav><main>${up}${low ? `<div style="height:1600px"></div>${low}<div style="height:600px"></div>` : ""}</main>`);
    });
    const origin = await listen(server); const f = setup(origin);
    try {
      raw.source.origin = origin; // The sole replacement: the made-up site instead of the example's.
      const script = normalizeTourScript(raw); assert.ok(script, `${file}: the example normalizes without repairs`);
      const login = { ...(signIn?.account ? { account: "made-up-account" } : {}), username: "made-up-user", password: "fake-pw-10" };
      const options = { context: f.context, script, tourId: "guide-fixture", editionId: "guide-edition", beforeContact: async (o: string) => { assert.equal(o, origin); }, ...(signIn ? { onSignIn: async () => login } : {}) };
      // A failure says what the recorder found, problems included, so a guide change that breaks the example is plain.
      const said = (e: unknown) => { throw e instanceof TourCaptureFailure ? new Error(`${file}: ${JSON.stringify(e.failure)}`) : e; };
      const dry = await runTourAttempt({ ...options, dryRun: true }).catch(said); assert.equal(dry.assets.size, 0);
      const recorded = await runTourAttempt({ ...options, dryRun: false }).catch(said);
      const all = recorded.steps.flatMap(s => s.views); const captures = all.flatMap(v => Object.values(v.captures));
      assert.equal(captures.length, views.reduce((n: number, v: any) => n + v.sizes.length, 0), `${file}: every page view at every size`);
      for (const c of captures) for (const m of c.marks) assert.ok(m.y >= 0 && m.y + m.h <= 1.001, `${file}: marks on the screen`);
      assert.ok(recorded.contactSheets.length > 0);
      for (const v of all) if (v.kind === "reference") { assert.deepEqual(v.captures, {}); assert.ok(v.reference); }
      for (const v of views) assert.ok(routes.includes(new URL(v.route, "http://x").pathname), `${file}: ${v.route} was loaded`);
      assert.equal(writes, 0, `${file}: no write but the sign-in`);
      if (signIn) assert.ok(signInPosts >= 1 && signInPosts <= 4, `${file}: signed in through its form (${signInPosts})`);
    } finally { await close(server); rmSync(f.root, { recursive: true, force: true }); }
  }
});

test("missing installed browser keeps its actionable refusal without leaking a configured path", { timeout: 15_000 }, async () => {
  const f = setup("http://127.0.0.1:4870"); const previous = process.env.SOVA_TOUR_BROWSER;
  process.env.SOVA_TOUR_BROWSER = join(f.root, "missing-private-executable");
  try {
    await assert.rejects(() => runTourAttempt({ context: f.context, script: f.script, tourId: "missing-browser", editionId: "missing-edition", dryRun: true, beforeContact: async () => {} }), (error: unknown) => error instanceof TourCaptureFailure && /configured recording browser cannot run/.test(error.message) && /SOVA_TOUR_BROWSER/.test(error.message) && !error.message.includes(f.root));
  } finally { if (previous === undefined) delete process.env.SOVA_TOUR_BROWSER; else process.env.SOVA_TOUR_BROWSER = previous; rmSync(f.root, { recursive: true, force: true }); }
});

test("cancellation during source approval refuses before launching the browser", async () => {
  const f = setup("http://127.0.0.1:4870"); const abort = new AbortController();
  try {
    await assert.rejects(() => runTourAttempt({ context: f.context, script: f.script, tourId: "cancel-preflight", editionId: "cancel-edition", dryRun: true, signal: abort.signal, beforeContact: async () => { abort.abort(); } }), /Recording cancelled/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("cancel reaps the installed browser tree and parent-owned temporary profile", { timeout: 30_000, skip: process.platform !== "linux" }, async () => {
  const server = createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end(html); });
  const origin = await listen(server); const f = setup(origin); const abort = new AbortController();
  const observed = new Map<number, string>(); let temporary: string | undefined;
  try {
    await assert.rejects(() => runTourAttempt({ context: f.context, script: f.script, tourId: "cancel-fixture", editionId: "cancel-edition", dryRun: false, signal: abort.signal, beforeContact: async () => {}, onProgress: () => {
      if (abort.signal.aborted) return;
      for (const name of readdirSync("/proc")) {
        if (!/^\d+$/.test(name)) continue;
        try {
          const env = readFileSync(`/proc/${name}/environ`, "utf8").split("\0");
          if (!env.includes(`PI_SESSION_FILE=${f.context.sessionFile}`)) continue;
          const pid = Number(name), start = procfsTable.startOf(pid); if (start) observed.set(pid, start);
          const dir = env.find(v => v.startsWith("TMPDIR="))?.slice(7);
          if (dir && /\/st-[^/]+$/.test(dir)) temporary = dir;
        } catch { /* unrelated process exited */ }
      }
      abort.abort();
    } }), /Recording cancelled/);
    assert.ok(observed.size >= 2, "observe the actual controller and browser, not just a cancelled job flag");
    assert.ok(temporary, "observe the parent's own temporary root");
    for (let i = 0; i < 100 && [...observed].some(([pid, stamp]) => procfsTable.startOf(pid) === stamp && !procfsTable.get(pid)?.zombie); i++) await new Promise(resolve => setTimeout(resolve, 20));
    for (const [pid, stamp] of observed) assert.ok(procfsTable.startOf(pid) !== stamp || procfsTable.get(pid)?.zombie, `recording process ${pid} must be stopped`);
    assert.equal(existsSync(temporary), false, "cancel removes the private browser/profile tree");
  } finally { await close(server); rmSync(f.root, { recursive: true, force: true }); }
});

test("server pipe loss closes the real browser instead of leaving an orphan", { timeout: 30_000, skip: process.platform !== "linux" }, async () => {
  const f = setup("http://127.0.0.1:4870");
  // A sandbox-off child runs only behind its attempt's own proxy; a closed port stands in (the browser
  // launches; nothing is contacted before the pipe goes).
  const handle = await spawnTourCommand(f.context, [process.execPath, fileURLToPath(new URL("./runner-child.ts", import.meta.url))], undefined, "http://127.0.0.1:9");
  const observed = new Map<number, string>(); let temporary: string | undefined;
  const lines = createInterface({ input: handle.process.stdout! });
  const exited = new Promise<number | null>((resolve, reject) => { handle.process.once("error", reject); handle.process.once("close", resolve); });
  try {
    lines.on("line", line => {
      const message = JSON.parse(line) as TourChildMessage;
      if (message.type !== "progress" || observed.size) return;
      for (const name of readdirSync("/proc")) {
        if (!/^\d+$/.test(name)) continue;
        try {
          const env = readFileSync(`/proc/${name}/environ`, "utf8").split("\0");
          if (!env.includes(`PI_SESSION_FILE=${f.context.sessionFile}`)) continue;
          const pid = Number(name), stamp = procfsTable.startOf(pid); if (stamp) observed.set(pid, stamp);
          const dir = env.find(v => v.startsWith("TMPDIR="))?.slice(7); if (dir && /\/st-[^/]+$/.test(dir)) temporary = dir;
        } catch { /* a process already exited */ }
      }
      handle.process.stdin!.end(); // EOF is the OS-visible result of losing the owning server.
    });
    handle.process.stdin!.write(`${JSON.stringify({ type: "start", input: { script: f.script, origin: "http://127.0.0.1:4870", dryRun: true } })}\n`);
    assert.notEqual(await exited, 0, "disconnect is interruption, never successful completion");
    assert.ok(observed.size >= 2, "the controller reached a real installed browser before pipe loss");
    await handle.dispose();
    for (let i = 0; i < 100 && [...observed].some(([pid, stamp]) => procfsTable.startOf(pid) === stamp && !procfsTable.get(pid)?.zombie); i++) await new Promise(resolve => setTimeout(resolve, 20));
    for (const [pid, stamp] of observed) assert.ok(procfsTable.startOf(pid) !== stamp || procfsTable.get(pid)?.zombie, `disconnected recording process ${pid} must stop`);
    assert.ok(temporary); assert.equal(existsSync(temporary), false);
  } finally { lines.close(); killTourChild(handle.process, "SIGKILL"); await handle.dispose(); rmSync(f.root, { recursive: true, force: true }); }
});

test("named loopback alias is refused inside recording before any application request", { timeout: 30_000 }, async () => {
  let requests = 0;
  const server = createServer((_req, res) => { requests++; res.setHeader("content-type", "text/html"); res.end(html); });
  const literal = await listen(server); const alias = literal.replace("127.0.0.1", "localhost."); const f = setup(alias);
  try {
    await assert.rejects(() => runTourAttempt({ context: f.context, script: f.script, tourId: "tour-fixture", editionId: "edition-fixture", dryRun: true, beforeContact: async () => {} }), (error: unknown) => error instanceof TourCaptureFailure && /This site name points at this computer or a private network/.test(error.message));
    assert.equal(requests, 0, "approval of a named origin never grants access to its private DNS address");
  } finally { await close(server); rmSync(f.root, { recursive: true, force: true }); }
});

test("GET from an otherwise semantic disclosure is refused before the server receives a mutation", { timeout: 30_000 }, async () => {
  let mutations = 0;
  const server = createServer((req, res) => { if (req.url === "/mutate") mutations++; res.setHeader("content-type", "text/html"); res.end(html.replace("this.setAttribute('aria-expanded','true');", "fetch('/mutate');this.setAttribute('aria-expanded','true');")); });
  const origin = await listen(server); const f = setup(origin);
  try {
    const view = f.script.steps[0]!.views[0]!; if (view.kind !== "page") throw new Error("fixture"); view.actions.desktop = [{ op: "open", target: { kind: "role", role: "button", name: "Details" } }];
    await assert.rejects(() => runTourAttempt({ context: f.context, script: f.script, tourId: "tour-fixture", editionId: "edition-fixture", beforeContact: async () => {}, dryRun: true }), (error: unknown) => error instanceof TourCaptureFailure && error.failure.stepId === "find-draft" && /GET is not assumed/.test(error.message));
    assert.equal(mutations, 0);
  } finally { await close(server); rmSync(f.root, { recursive: true, force: true }); }
});

test("unknown subresource origin receives zero requests and preserves the approval-blocked error", { timeout: 30_000 }, async () => {
  let requests = 0; const privateServer = createServer((_req, res) => { requests++; res.end("private"); });
  const unknown = await listen(privateServer);
  const server = createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end(`${html}<img src="${unknown}/private">`); });
  const origin = await listen(server); const f = setup(origin); const blocked = new Error("site approval required");
  try {
    await assert.rejects(() => runTourAttempt({ context: f.context, script: f.script, tourId: "tour-fixture", editionId: "edition-fixture", dryRun: true, beforeContact: async o => { if (o !== origin) throw blocked; } }), error => error === blocked);
    assert.equal(requests, 0);
  } finally { await close(server); await close(privateServer); rmSync(f.root, { recursive: true, force: true }); }
});

test("ambiguous targets report the exact step and nearby targets instead of selecting first", { timeout: 30_000 }, async () => {
  const server = createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end(html.replace("</main>", "<h1>Saved drafts</h1></main>")); });
  const origin = await listen(server); const f = setup(origin);
  try {
    await assert.rejects(() => runTourAttempt({ context: f.context, script: f.script, tourId: "tour-fixture", editionId: "edition-fixture", dryRun: true, beforeContact: async () => {} }), (error: unknown) => error instanceof TourCaptureFailure && error.failure.stepId === "find-draft" && error.failure.problems?.[0]?.matches === 2 && error.failure.problems[0].at[0]?.stepId === "find-draft" && !!error.failure.problems[0].nearby?.length);
  } finally { await close(server); rmSync(f.root, { recursive: true, force: true }); }
});

test("HTTP Basic test-account sign-in uses only its exact origin in the isolated browser", { timeout: 30_000 }, async () => {
  let authenticated = 0;
  const server = createServer((req, res) => {
    if (req.headers.authorization !== `Basic ${Buffer.from("fixture:fake-pw-09").toString("base64")}`) { res.writeHead(401, { "www-authenticate": 'Basic realm="tour-test"' }); res.end(); return; }
    authenticated++; res.setHeader("content-type", "text/html"); res.end(html);
  });
  const origin = await listen(server); const f = setup(origin);
  try {
    const result = await runTourAttempt({ context: f.context, script: f.script, tourId: "tour-fixture", editionId: "edition-fixture", dryRun: true, beforeContact: async () => {}, account: { origin, username: "fixture", password: "fake-pw-09" } });
    assert.equal(result.assets.size, 0); assert.ok(authenticated >= 2);
    assert.ok(!JSON.stringify(result).includes("fake-pw-09"));
  } finally { await close(server); rmSync(f.root, { recursive: true, force: true }); }
});
