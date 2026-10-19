import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { TourJob, TourScriptRequest, TourVerification } from "../../shared/tour";
import { scratchRoot } from "../test-scratch";

// A real recording of a managed Sova copy, end to end inside this process: the copy is the real app
// (buildApp, auth gate, its own .agent and install token, a keyless loopback model provider), the
// recorder is the real one (TourRuntime → runTourAttempt → a real child and Chromium, sandbox off).
// Two promises are held here and nowhere else:
//  (a) the copy's install token, raw or as its cookie, appears in nothing the recording leaves: no
//      file under the runtime's root, not the child's stderr, not a tool result, after a success and
//      after a forced failure;
//  (b) the recorder's views (the idle UI's own load-time requests included) never make the copy call
//      a model: a counting stub provider sees no request and no title/summary record appears; an
//      ordinary operator action afterwards does reach the stub (the positive control), so the 0 means
//      "no call", not "stub unwired".
// The copy's background title sweep is never started (index.ts starts it, buildApp doesn't) and its
// settings switch is off here, so a model call could hide behind it: what would nudge it, a session's
// summary line changing (index.ts: onSummaryLineChanged → sweep.nudge), is counted directly over the
// recording window instead (0), on an index already warm as a running copy's is, with a positive
// control that makes one change and sees it.

const root = scratchRoot("tour-sova-copy-");
const checkout = join(root, "copy"), agentDir = join(checkout, ".agent"), state = join(agentDir, "sova");
const ENV = ["PI_CODING_AGENT_DIR", "HOME", "SOVA_CHAT_STATE_ROOT", "SOVA_PRICES_FETCH", "SOVA_MODELS_FETCH", "PI_OFFLINE", "SOVA_AUTH", "SOVA_TOKEN", "HOST", "SOVA_ALLOWED_HOSTS", "SOVA_ALLOWED_ORIGINS", "SOVA_SHARE_PUBLIC_URL"];
const previousEnv = new Map(ENV.map(n => [n, process.env[n]]));
process.env.PI_CODING_AGENT_DIR = agentDir; process.env.HOME = root; process.env.SOVA_CHAT_STATE_ROOT = state;
process.env.SOVA_PRICES_FETCH = "off"; process.env.SOVA_MODELS_FETCH = "off"; process.env.PI_OFFLINE = "1";
for (const n of ["SOVA_AUTH", "SOVA_TOKEN", "HOST", "SOVA_ALLOWED_HOSTS", "SOVA_ALLOWED_ORIGINS", "SOVA_SHARE_PUBLIC_URL"]) delete process.env[n];
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true }); mkdirSync(state, { recursive: true });

async function listen(server: Server): Promise<number> { await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); return (server.address() as AddressInfo).port; }
async function close(server: Server): Promise<void> { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
function send(port: number, path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<{ status: number; headers: IncomingHttpHeaders; text: string }> {
  const body = init.body === undefined ? undefined : JSON.stringify(init.body);
  return new Promise((done, fail) => {
    const req = request({ host: "127.0.0.1", port, path, method: init.method ?? "GET", agent: false, headers: { ...(body ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)) } : {}), ...init.headers } }, res => {
      const chunks: Buffer[] = [];
      res.on("data", c => chunks.push(Buffer.from(c)));
      res.on("end", () => done({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", fail);
    });
    req.on("error", fail); req.setTimeout(60_000, () => req.destroy(new Error("The fixture request timed out."))); req.end(body);
  });
}
/** Every file under a directory, as bytes (links are not followed: lstat-free readdir with types). */
function filesUnder(dir: string): { path: string; bytes: Buffer }[] {
  if (!existsSync(dir)) return [];
  const out: { path: string; bytes: Buffer }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(path));
    else if (entry.isFile()) out.push({ path, bytes: readFileSync(path) });
    else out.push({ path, bytes: Buffer.from(`<${entry.isSymbolicLink() ? "link" : "special"}>`) });
  }
  return out;
}
/** Title and summary records of the copy: every file under its .agent whose name says so, with its bytes. */
function titleAndSummaryRecords(): Map<string, string> {
  return new Map(filesUnder(agentDir).filter(f => /title|summar|outline/i.test(f.path.slice(agentDir.length))).map(f => [f.path, f.bytes.toString("base64")]));
}

test("recording a managed Sova copy leaves its install token nowhere and never makes it call a model", { timeout: 600_000 }, async () => {
  // The stub model provider: counts every request; answers a chat completion with a fixed title.
  const stub = { requests: [] as string[] };
  const stubServer = createServer((req, res) => {
    stub.requests.push(`${req.method} ${req.url}`);
    req.resume();
    req.on("end", () => {
      const chunk = (delta: object, finish: string | null) => `data: ${JSON.stringify({ id: "stub-1", object: "chat.completion.chunk", created: 1, model: "tiny", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(chunk({ role: "assistant", content: JSON.stringify({ title: "Made up stub title" }) }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
    });
  });
  const stubPort = await listen(stubServer);
  // Keyless as the credentials gate admits it: a loopback provider with a short literal placeholder.
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { stub: { baseUrl: `http://127.0.0.1:${stubPort}/v1`, api: "openai-completions", apiKey: "stub", models: [{ id: "tiny" }] } } }, null, 2));
  writeFileSync(join(state, "session-titles-settings.json"), JSON.stringify({ version: 1, enabled: false, intervalMinutes: 5, quietMinutes: 0, primary: { backend: "pi", model: "stub/tiny", effort: "off" }, fallback: null }, null, 2));

  const { linkPiConfigExtensions } = await import("../testing/agent-dir"); linkPiConfigExtensions(agentDir);
  await import("../testing/in-process-chats");
  const { createSessionFile } = await import("../harness/pi/state");
  const { SANDBOX } = await import("../harness/state-kinds");
  const { canonicalPath } = await import("../paths");
  mkdirSync(join(agentDir, "sessions", "copy"), { recursive: true });
  // A made-up session on the copy, with a first request, so a title ask has something to name.
  const seeded = createSessionFile({ cwd: checkout, sessionsDir: join(agentDir, "sessions", "copy"), seed: [[SANDBOX, { version: 1, on: false, level: "workspace-write", workers: "off" }]] });
  const lines = readFileSync(seeded.path, "utf8").trim().split("\n");
  const lastId = (JSON.parse(lines.at(-1)!) as { id?: string }).id ?? null;
  writeFileSync(seeded.path, `${[...lines, JSON.stringify({ type: "message", id: "made-up-user-1", parentId: lastId, timestamp: "2026-01-02T03:04:05.000Z", message: { role: "user", content: "Explain where a made-up saved draft waits before it is sent." } })].join("\n")}\n`);
  const seededPath = canonicalPath(seeded.path);

  // The copy: the real app on its own listener, its own install token, its own state.
  const { buildApp } = await import("../app"); const { app } = buildApp({ extensionEntriesOf: async () => [] });
  const { getRequestListener } = await import("@hono/node-server");
  const { authCookieName, initAuthToken, setAuthHosts, setAuthPort, tourRecorderCookieName } = await import("../auth");
  assert.equal(initAuthToken().problem, null);
  setAuthHosts(() => ({ magicDns: null, own: [], peers: [] }));
  const seen: { method: string; path: string; recorder: boolean }[] = [];
  const listener = getRequestListener(app.fetch);
  const copyServer = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    seen.push({ method: req.method ?? "", path, recorder: req.headers["x-sova-tour-recorder"] !== undefined });
    if (req.method === "GET" && path === "/") documents.push({ at, ms: Math.round(performance.now() - atSince) });
    void listener(req, res);
  });
  const copyPort = await listen(copyServer); setAuthPort(copyPort);
  const copyOrigin = `http://127.0.0.1:${copyPort}`;
  const { attachWebSockets } = await import("../ws"); attachWebSockets(copyServer);
  // Every socket handshake (all of them the recorder's here): its path, header and marker cookie.
  // Each is attributed to the recorder run and view in progress when it arrived (`at`, below).
  const upgrades: { path: string; keys: string[]; header: boolean; marker: boolean; at: string; ms: number }[] = [];
  const documents: { at: string; ms: number }[] = [];
  let at = "before any run", atSince = performance.now();
  const markerName = tourRecorderCookieName(agentDir);
  copyServer.on("upgrade", req => { const u = new URL(req.url ?? "/", "http://x"); upgrades.push({ path: u.pathname, keys: [...new Set(u.searchParams.keys())].sort(), header: req.headers["x-sova-tour-recorder"] !== undefined, marker: (req.headers.cookie ?? "").split(";").some(c => c.trim() === `${markerName}=1`), at, ms: Math.round(performance.now() - atSince) }); });
  const token = readFileSync(join(state, "auth-token"), "utf8").trim();
  const cookie = `${authCookieName(agentDir)}=${token}`;
  assert.ok(token.length >= 16, "the copy minted its install token");

  // Positive controls for the copy's gate: its status answers only with the cookie, and the recorder
  // header earns nothing by itself.
  assert.equal((await send(copyPort, "/api/auth/status")).status, 401);
  assert.equal((await send(copyPort, "/api/auth/status", { headers: { "x-sova-tour-recorder": "1" } })).status, 401);
  const signedIn = await send(copyPort, "/api/auth/status", { headers: { Cookie: cookie } });
  assert.equal(signedIn.status, 200); assert.deepEqual(JSON.parse(signedIn.text), { ok: true });

  // The recorder under test: the default runner, its child's stderr teed for the scan.
  const runtimeRoot = join(root, "runtime");
  const { TourRuntime } = await import("./runtime");
  const { runTourAttempt } = await import("./runner");
  const { spawnTourCommand } = await import("./sandbox");
  const { stateView } = await import("../harness/state-view");
  let stderr = "";
  const sessionFile = join(root, "recorder-chat.jsonl");
  const view = stateView([{ kind: "state", id: "sandbox", parentId: null, key: "sandbox", data: { version: 1, on: false, level: "workspace-write", enforcement: "none", backend: "test" } }] as Parameters<typeof stateView>[0]);
  const caller = { sessionId: "sova-copy-recorder", sessionFile, cwd: checkout, state: view };
  const record = { id: "copy-s", project: root, checkout, branch: "feat/made-up", slot: 6, generation: 1, createdBy: "operator", createdAt: "2026-01-02T03:04:05.000Z", cutWorktree: false, desired: { server: "running" }, prints: {}, data: {}, ports: { server: { http: copyPort } } };
  let runs = 0;
  const runtime = new TourRuntime({
    root: runtimeRoot,
    context: {
      canonical: p => p,
      registry: () => ({ version: 1, instances: [record], shared: [] }) as never,
      projects: async () => [{ id: "sova", root }],
      snapshot: async () => ({ sessionId: caller.sessionId, sessionFile, cwd: checkout, agentDir: join(root, "recorder-agent"), state: view, held: { on: false, enforcement: "none" } }),
    },
    target: async () => ({ origin: copyOrigin, generation: 1, sova: { agentDir }, assertCurrent: async () => {} }),
    // Every recorder run (a dry-run job runs once; a record job repeats the dry run, then captures),
    // numbered, with the view in progress as each handshake or page load arrives.
    run: input => { const n = ++runs; const label = `run ${n} ${input.dryRun ? "dry" : "capture"}`; at = label; atSince = performance.now(); return runTourAttempt({ ...input, onProgress: p => { if (p.viewId && p.size) { const next = `${label}|${p.viewId}|${p.size}`; if (next !== at) { at = next; atSince = performance.now(); } } input.onProgress?.(p); }, spawn: async (...args) => { const child = await spawnTourCommand(...args); child.process.stderr?.on("data", (b: Buffer) => { stderr += b.toString("utf8"); }); return child; } }); },
  });
  // The short form an agent sends: the running copy alone, as project_verbs status names it. Sova
  // derives the project id and checkout and stores the full identity.
  const source = { kind: "project" as const, instanceId: "copy-s", serviceId: "server", endpoint: "http" };
  const page = (id: string, route: string, marks: { target: { kind: "text"; text: string }; label: string; side: "right" }[] = []) => ({ id, title: `View ${id}`, kind: "page" as const, note: "A made-up view of the test copy.", route, sizes: ["desktop", "phone"] as ("desktop" | "phone")[], actions: {}, marks, masks: [] });
  const script = (views: ReturnType<typeof page>[]): TourScriptRequest => ({ v: 1, title: "The test copy at rest", summary: "What an idle test copy shows.", audience: "A new reviewer", outcome: "Know the copy's idle views.", source, chapters: [{ id: "idle", title: "Idle" }], steps: [{ id: "idle-views", chapter: "idle", title: "Idle views", summary: "The views the copy loads at rest.", views }] });
  // The idle UI itself (the built app: its own load-time requests come from the page), then the
  // load-time API set as plain pages.
  // A run that comes before `pnpm run build` (the merge round runs test:int first) builds the app here.
  const repo = resolve(import.meta.dirname, "../..");
  if (!existsSync(join(repo, "dist/index.html"))) execFileSync(join(repo, "node_modules/.bin/vite"), ["build"], { cwd: repo, stdio: "ignore", timeout: 240_000 });
  assert.ok(existsSync(join(repo, "dist/index.html")), "The idle UI's load-time requests come from the built app, and building it here failed: run `pnpm run build`.");
  const idle = script([
    page("ui", "/"),
    // Two hash routes of the app in a row: each loads fresh (a fragment-only change would otherwise
    // be a same-document navigation with no response to check).
    page("orgs", "/#/orgs"), page("themes", "/#/settings/themes"),
    // The whole answer is one <pre>; exact text. A signed-out copy answers 401 with another body.
    page("status", "/api/auth/status", [{ target: { kind: "text", text: '{"ok":true}' }, label: "Signed in by the copy's own cookie.", side: "right" }]),
    page("sessions", "/api/sessions"), page("settings", "/api/settings"), page("overseer", "/api/overseer"), page("attention", "/api/overseer/attention"),
  ]);
  const results: unknown[] = [];
  const settled = async (id: string): Promise<TourJob> => {
    for (let i = 0; i < 3000; i++) {
      const job = runtime.queue.get(caller.sessionId, id)!;
      if (["checking", "ready", "failed", "cancelled", "needs-site-approval", "needs-test-account"].includes(job.phase)) { results.push(await runtime.status(caller, id)); return job; }
      await new Promise(ok => setTimeout(ok, 100));
    }
    throw new Error("The recording did not settle.");
  };
  const assertNoToken = (when: string) => {
    const forms = [token, cookie];
    for (const f of filesUnder(runtimeRoot)) for (const form of forms) assert.equal(f.bytes.indexOf(form), -1, `${when}: ${f.path.slice(root.length)} holds the token`);
    for (const form of forms) {
      assert.equal(stderr.includes(form), false, `${when}: the child's stderr holds the token`);
      assert.equal(JSON.stringify(results).includes(form), false, `${when}: a tool result holds the token`);
    }
    assert.ok(filesUnder(runtimeRoot).length > 0, "the scan read the runtime's files");
  };
  // A running copy has read its sessions already: warm the index, then count summary-line changes.
  const { listSessions, onSummaryLineChanged } = await import("../sessions-index");
  await listSessions();
  let summaryChanges = 0;
  const unwatch = onSummaryLineChanged(() => { summaryChanges++; });
  const titlesBefore = titleAndSummaryRecords();
  const sessionBefore = readFileSync(seeded.path, "utf8");
  try {
    runtime.approvals.approve(copyOrigin);
    // (a) Success: dry run, record, inspect every picture asked for, check, publish.
    const dry = await runtime.dryRun(caller, idle, "sova-copy-idle"); results.push(dry);
    const dryJob = await settled(dry.job.id);
    assert.equal(dryJob.phase, "checking", JSON.stringify(dryJob.failure));
    assert.deepEqual(runtime.artifacts.read(caller.sessionId, dry.job.id)?.script.source, { kind: "project", projectId: "sova", instanceId: "copy-s", checkout, serviceId: "server", endpoint: "http" }, "the short source was stored as the derived full identity");
    const capture = await runtime.record(caller, dry.job.id); results.push(capture);
    assert.equal((await settled(capture.job.id)).phase, "checking");
    const overview = await runtime.inspect(caller, capture.job.id);
    results.push(overview.result, ...overview.content.filter(c => c.type === "text"));
    const suspicious = (JSON.parse((overview.content[0] as { text: string }).text) as { suspicious: string[] }).suspicious;
    for (const file of suspicious) { const r = await runtime.inspect(caller, capture.job.id, file); results.push(r.result, ...r.content.filter(c => c.type === "text")); }
    const verification: TourVerification = { overviewReviewed: true, suspiciousCapturesReviewed: suspicious, notes: "Reviewed every overview cell and each suspicious capture of the made-up copy." };
    const checked = await runtime.check(caller, capture.job.id, verification); results.push(checked);
    assert.equal(checked.job.phase, "ready");
    // The recorder reached every view, the status by its cookie (a non-ok answer fails the attempt),
    // and wrote nothing.
    const recorded = seen.filter(s => s.recorder);
    for (const path of ["/", "/api/auth/status", "/api/sessions", "/api/settings", "/api/overseer", "/api/overseer/attention"]) assert.ok(recorded.some(s => s.method === "GET" && s.path === path), `the recorder viewed ${path}`);
    assert.deepEqual(recorded.filter(s => s.method !== "GET" && s.method !== "HEAD"), [], "the recorder sent no write");
    assert.ok(recorded.some(s => s.path.startsWith("/assets/")), "the idle UI loaded the built app");
    assertNoToken("after a published recording");

    // (a) Forced failure: a view whose target the copy doesn't show.
    const broken = script([page("sessions", "/api/sessions", [{ target: { kind: "text", text: "A made-up label no copy shows" }, label: "Never there.", side: "right" }])]);
    const failedDry = await runtime.dryRun(caller, broken, "sova-copy-broken"); results.push(failedDry);
    const failed = await settled(failedDry.job.id);
    assert.equal(failed.phase, "failed"); assert.equal(failed.failure?.viewId, "sessions");
    assertNoToken("after a failed recording");

    // (b) The recorder's views made the copy call no model and name nothing.
    assert.deepEqual(stub.requests, [], "no provider request during recording");
    assert.deepEqual(titleAndSummaryRecords(), titlesBefore, "no new title or summary record");
    assert.equal(readFileSync(seeded.path, "utf8"), sessionBefore, "the copy's session is unchanged");
    assert.equal(summaryChanges, 0, "nothing the recorder did would nudge the copy's title sweep");
    // Every recorder handshake was a watch, marked by the header or the copy-bound marker cookie.
    assert.ok(upgrades.some(u => u.path === "/ws/watch"), `the idle UI opened its watch socket: ${JSON.stringify(upgrades)}`);
    for (const u of upgrades) { assert.equal(u.path, "/ws/watch"); assert.ok(u.header || u.marker, `a marked handshake: ${JSON.stringify(u)}`); }
    // Exactly one document load and one watch socket (the session feed) per app view, size and run:
    // runs 1 (the dry-run job), 2 and 3 (the record job's repeated dry run, then its capture), for the
    // app views ui, orgs and themes. A load the recorder doubled, or a socket the app reopened, shows
    // here by run, view and size. The attempt fails on any frame the page sends, so none was sent.
    const tally = (list: { at: string }[]) => list.reduce<Record<string, number>>((m, x) => { m[x.at] = (m[x.at] ?? 0) + 1; return m; }, {});
    const expected: Record<string, number> = {};
    for (const run of ["run 1 dry", "run 2 dry", "run 3 capture"]) for (const view of ["ui", "orgs", "themes"]) for (const size of ["desktop", "phone"]) expected[`${run}|${view}|${size}`] = 1;
    const log = `handshakes ${JSON.stringify(upgrades)}; document loads ${JSON.stringify(documents)}`;
    assert.deepEqual(tally(documents), expected, `one document load per app view, size and run: ${log}`);
    assert.deepEqual(tally(upgrades), expected, `one watch handshake per app view, size and run: ${log}`);
    for (const u of upgrades) assert.deepEqual(u.keys, ["feed"], `the session feed, nothing else: ${JSON.stringify(u)}`);

    // Positive control for the nudge counter: a summary line appears in the seeded session.
    const outline = JSON.stringify({ type: "custom", customType: "topic-outline", data: { version: 2, now: "A made-up assistant is reading.", overall: "A made-up draft review.", topics: [], generatedAt: 1 } });
    writeFileSync(seeded.path, `${sessionBefore}${outline}\n`);
    await listSessions();
    assert.ok(summaryChanges >= 1, "the counter sees a real summary-line change");

    // Positive control: the operator's own Name button on the copy does reach the stub.
    const named = await send(copyPort, "/api/sessions/auto-title", { method: "POST", headers: { Cookie: cookie, Origin: copyOrigin, "Sec-Fetch-Site": "same-origin" }, body: { paths: [seededPath] } });
    assert.equal(named.status, 200, named.text);
    assert.ok(stub.requests.length > 0, `the stub counts a real model call (${named.text})`);
  } finally {
    unwatch();
    runtime.close();
    await close(copyServer); await close(stubServer);
    rmSync(root, { recursive: true, force: true });
    for (const [n, v] of previousEnv) if (v === undefined) delete process.env[n]; else process.env[n] = v;
  }
});
