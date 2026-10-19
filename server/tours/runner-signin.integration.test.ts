// al_6, the recorder's form sign-in against a made-up site and the installed browser (sandbox off,
// the attempt's own proxy): exactly one sign-in POST per sign-in, only from the recorder's own click;
// the sign-in page never captured; password and username boxes blacked out; a page's own writes
// stopped quietly; wrong details, a code, a human check, an expired session, a self-submitting page.
import assert from "node:assert/strict";
import { once } from "node:events";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runTourAttempt, type TourAttemptResult } from "./runner";
import { spawnTourCommand } from "./sandbox";
import { TourRuntime } from "./runtime";
import { stateView } from "../harness/state-view";
import type { TourJob } from "../../shared/tour";
import type { TourToolCaller } from "./tools";
import { TOUR_SIGN_IN_HUMAN, TOUR_SIGN_IN_WRONG } from "./runner-protocol";
import { ACCOUNT, CODE, MASK, PASS, USER, failed, pngPixel, record, script, site } from "./runner-signin.integration.fixture";

test("native form: one prompt, exactly one sign-in POST for both sizes, boxes blacked out, the sign-in page never captured", { timeout: 120_000 }, async () => {
  const s = await site();
  try {
    const { result, asked, stored } = await record(script(s.origin, ["/account"]), { dryRun: false });
    assert.equal(failed(result), "recorded");
    const r = result as TourAttemptResult;
    assert.equal(s.hits("POST /login"), 1, "the phone context reused the desktop sign-in");
    assert.deepEqual(asked, ["username+password"]);
    assert.equal(stored.length, 1);
    assert.equal(r.signedIn, true);
    assert.deepEqual([...r.assets.keys()].filter(f => f.startsWith("capture-")).sort(), ["capture-1-1-desktop.png", "capture-1-1-phone.png"]);
    for (const file of ["capture-1-1-desktop.png", "capture-1-1-phone.png"]) {
      assert.deepEqual(pngPixel(r.assets.get(file)!, 120, 320), MASK, `${file}: username box`);
      assert.deepEqual(pngPixel(r.assets.get(file)!, 120, 420), MASK, `${file}: password box`);
    }
    assert.ok(!JSON.stringify({ ...r, assets: [...r.assets.keys()] }).includes(PASS));
    // A next attempt that starts from the stored session signs in no more, and still counts as signed in.
    const again = await record(script(s.origin, ["/account"]), { storage: stored[0] });
    assert.equal(failed(again.result), "recorded");
    assert.deepEqual(again.asked, []);
    assert.equal(s.hits("POST /login"), 1);
    assert.equal((again.result as TourAttemptResult).signedIn, true);
  } finally { s.close(); }
});

test("a fetch-submit sign-in reaches the site exactly once", { timeout: 120_000 }, async () => {
  const s = await site({ fetchSubmit: true });
  try {
    const { result } = await record(script(s.origin, ["/account"]));
    assert.equal(failed(result), "recorded");
    assert.equal(s.hits("POST /login"), 1);
    assert.equal(s.hits("account-sent"), 0, "no account box declared, no account sent");
  } finally { s.close(); }
});

test("an account box pre-filled by the page is cleared and typed first: one POST with exactly the supplied account, all three boxes blacked out", { timeout: 120_000 }, async () => {
  const s = await site({ account: true, fetchSubmit: true });
  try {
    const { result, asked } = await record(script(s.origin, ["/account"], true), { dryRun: false });
    assert.equal(failed(result), "recorded");
    assert.deepEqual(asked, ["account+username+password"]);
    assert.equal(s.hits("POST /login"), 1);
    assert.equal(s.hits(`account=${ACCOUNT}`), 1, "the typed account replaced the pre-fill, not appended to it");
    assert.equal(s.hits("account-sent"), 1);
    const r = result as TourAttemptResult;
    for (const file of ["capture-1-1-desktop.png", "capture-1-1-phone.png"]) {
      assert.deepEqual(pngPixel(r.assets.get(file)!, 120, 320), MASK, `${file}: username box`);
      assert.deepEqual(pngPixel(r.assets.get(file)!, 120, 420), MASK, `${file}: password box`);
      assert.deepEqual(pngPixel(r.assets.get(file)!, 120, 520), MASK, `${file}: account box`);
    }
  } finally { s.close(); }
  // Control: the same fixture with no declared account box sends the pre-fill, and the site refuses it.
  const control = await site({ account: true, fetchSubmit: true });
  try {
    const { result } = await record(script(control.origin, ["/account"]));
    assert.notEqual(failed(result), "recorded");
    assert.equal(control.hits(`account=${ACCOUNT}`), 0);
  } finally { control.close(); }
});

test("a signed-in page's own analytics write is stopped quietly and counted; nothing reaches the site", { timeout: 120_000 }, async () => {
  const s = await site();
  try {
    const { result } = await record(script(s.origin, ["/account?analytics=1"]));
    assert.equal(failed(result), "recorded");
    assert.equal(s.hits("POST /analytics"), 0);
    assert.ok(((result as TourAttemptResult).quietAborts ?? 0) >= 2, "fetch and beacon, at least one size");
  } finally { s.close(); }
});

test("a session that expires mid-run gets one silent re-sign-in; a second expiry in the attempt fails", { timeout: 120_000 }, async () => {
  // Each session lasts two account loads: the one after the sign-in's redirect and the view's fresh load.
  const s = await site({ loadsPerSession: 2 });
  try {
    const { result, asked } = await record(script(s.origin, ["/account"]));
    assert.equal(failed(result), "recorded");
    assert.equal(s.hits("POST /login"), 2, "desktop signs in, phone's load finds it expired and signs in again");
    assert.equal(asked.length, 2);
  } finally { s.close(); }
  const short = await site({ loadsPerSession: 1 });
  try {
    const { result } = await record(script(short.origin, ["/account"]));
    assert.match(failed(result), /The site signed the recorder out again, so recording stopped\./);
    assert.equal(short.hits("POST /login"), 2);
  } finally { short.close(); }
});

test("wrong details: one POST, the fixed failure, no retry", { timeout: 120_000 }, async () => {
  const s = await site();
  try {
    const { result } = await record(script(s.origin, ["/account"]), { answer: () => ({ username: USER, password: "fake-pw-08" }) });
    assert.match(failed(result), new RegExp(TOUR_SIGN_IN_WRONG.replace(/[.?]/g, "\\$&")));
    assert.match(failed(result), /Tell the user the login didn't work/, "hands-off: the user gives the login, never another way in");
    assert.equal(s.hits("POST /login"), 1);
  } finally { s.close(); }
});

test("a one-time code is asked for and typed into the same browser", { timeout: 120_000 }, async () => {
  const s = await site({ code: true });
  try {
    const { result, asked } = await record(script(s.origin, ["/account"]));
    assert.equal(failed(result), "recorded");
    assert.deepEqual(asked, ["username+password", "code"]);
    assert.equal(s.hits("POST /login"), 1); assert.equal(s.hits("POST /code"), 1);
  } finally { s.close(); }
});

test("a human check stops the recording before anything is typed or sent", { timeout: 120_000 }, async () => {
  const s = await site({ captcha: true });
  try {
    const { result, asked } = await record(script(s.origin, ["/account"]));
    assert.match(failed(result), new RegExp(TOUR_SIGN_IN_HUMAN.replace(/[.?']/g, "\\$&")));
    assert.match(failed(result), /^This site asks to prove you're human, so recording stopped\. Tell the user, or use reference text\./);
    assert.doesNotMatch(failed(result), /signed in another way/, "hands-off: never another way in");
    assert.deepEqual(asked, []);
    assert.equal(s.hits("POST /login"), 0);
  } finally { s.close(); }
});

test("a page that submits the sign-in form itself fails the attempt with nothing sent; a page's own POST on load is stopped quietly", { timeout: 120_000 }, async () => {
  const self = await site({ selfSubmit: true });
  try {
    const { result } = await record(script(self.origin, ["/account"]));
    assert.match(failed(result), /Blocked form submission during read-only recording\./);
    assert.equal(self.hits("POST /login"), 0);
  } finally { self.close(); }
  const onLoad = await site({ postOnLoad: true });
  try {
    const { result } = await record(script(onLoad.origin, ["/account"]));
    assert.equal(failed(result), "recorded");
    assert.equal(onLoad.hits("POST /login"), 1, "only the recorder's own click reached the site");
    assert.ok(((result as TourAttemptResult).quietAborts ?? 0) >= 1);
  } finally { onLoad.close(); }
});

test("a change-password page is not a sign-in: its boxes are never typed into or sent, and blacked out", { timeout: 120_000 }, async () => {
  const s = await site();
  try {
    const { result, asked } = await record(script(s.origin, ["/settings/password"]), { dryRun: false });
    assert.equal(failed(result), "recorded");
    // The one sign-in is the up-front one, on the sign-in page; the change-password page's boxes are never typed into.
    assert.deepEqual(asked, ["username+password"]);
    assert.equal(s.hits("POST /login"), 1);
    assert.equal(s.hits("POST /settings/password"), 0);
    const r = result as TourAttemptResult;
    assert.equal(r.signedIn, true);
    for (const file of ["capture-1-1-desktop.png", "capture-1-1-phone.png"]) {
      assert.deepEqual(pngPixel(r.assets.get(file)!, 120, 320), MASK, `${file}: current password`);
      assert.deepEqual(pngPixel(r.assets.get(file)!, 120, 420), MASK, `${file}: new password`);
    }
  } finally { s.close(); }
});

/** Every regular file under `dir` (links not followed) holding any canary, raw or URL-encoded: the paths. */
function scan(dir: string, canaries: string[]): string[] {
  const forms = canaries.flatMap(c => [c, encodeURIComponent(c)]).map(f => Buffer.from(f, "latin1"));
  const found: string[] = [];
  const walk = (d: string) => {
    let names: string[] = [];
    try { names = readdirSync(d); } catch { return; }
    for (const name of names) {
      const p = join(d, name);
      let st; try { st = lstatSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) { try { const bytes = readFileSync(p); if (forms.some(f => bytes.includes(f))) found.push(p); } catch { /* gone or unreadable */ } }
    }
  };
  walk(dir);
  return found;
}

test("while parked for a code after the password sign-in, no login or session value is on disk or in any output", { timeout: 180_000, skip: process.platform !== "linux" && "reads the child's TMPDIR from /proc" }, async () => {
  const s = await site({ code: true, account: true });
  const root = mkdtempSync(join(tmpdir(), "tour-r6-"));
  const state = () => stateView([{ kind: "state", id: "sandbox", parentId: null, key: "sandbox", data: { version: 1, on: false, level: "workspace-write", enforcement: "none", backend: "test" } }]);
  const caller: TourToolCaller = { sessionId: "chat-r6", sessionFile: join(root, "chat.jsonl"), cwd: root, state: state() };
  // The child's own temporary root (Playwright's profile lives there) and everything it and this process print.
  const childRoots: string[] = [];
  let childOut = "", childErr = "", serverOut = "";
  const write = { out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => { serverOut += String(chunk); return (write.out as (...a: unknown[]) => boolean)(chunk, ...rest); }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => { serverOut += String(chunk); return (write.err as (...a: unknown[]) => boolean)(chunk, ...rest); }) as typeof process.stderr.write;
  const runtime = new TourRuntime({ root: join(root, "state"),
    context: { canonical: p => p, snapshot: async () => ({ sessionId: caller.sessionId, sessionFile: caller.sessionFile, cwd: root, agentDir: join(root, "agent"), state: state(), held: { on: false, enforcement: "none" } }) },
    target: async () => ({ origin: s.origin, assertCurrent: async () => {} }),
    run: options => runTourAttempt({ ...options, spawn: async (...args) => {
      const child = await spawnTourCommand(...args);
      const pid = child.process.pid!;
      // Read once the child has exec'd (before that, /proc shows this process's environment).
      for (let i = 0; i < 200 && !readFileSync(`/proc/${pid}/cmdline`, "latin1").includes("runner-child"); i++) await new Promise(r => setTimeout(r, 5));
      const env = readFileSync(`/proc/${pid}/environ`, "latin1").split("\0").find(e => e.startsWith("TMPDIR="));
      if (env) childRoots.push(env.slice("TMPDIR=".length));
      child.process.stdout?.on("data", (b: Buffer) => { childOut += b.toString("latin1"); });
      child.process.stderr?.on("data", (b: Buffer) => { childErr += b.toString("latin1"); });
      return child;
    } }),
  });
  const phase = async (id: string, wanted: (j: TourJob) => boolean) => {
    for (let i = 0; i < 1200; i++) { const j = runtime.queue.get(caller.sessionId, id)!; if (wanted(j)) return j; await new Promise(r => setTimeout(r, 50)); }
    throw new Error(`job stayed ${runtime.queue.get(caller.sessionId, id)?.phase}`);
  };
  try {
    runtime.approvals.approve(s.origin);
    const dry = await runtime.dryRun(caller, script(s.origin, ["/account"], true), "tour-r6");
    await phase(dry.job.id, j => j.phase === "needs-sign-in" && j.requirements?.signIn?.fields[0] === "account");
    await runtime.signIn(caller, dry.job.id, { origin: s.origin, account: ACCOUNT, username: USER, password: PASS });
    await phase(dry.job.id, j => j.phase === "needs-sign-in" && j.requirements?.signIn?.fields[0] === "code");
    // Parked: the password sign-in is done and its cookie is held by the live browser.
    const pre = s.cookies().pre;
    assert.ok(pre, "the site set its pre-code session cookie");
    assert.equal(childRoots.length, 1);
    const tmp = childRoots[0]!;
    assert.ok(readdirSync(tmp).length > 0, "the child's temporary root holds its browser profile");
    const canaries = [PASS, USER, ACCOUNT, pre];
    // Positive control: a planted canary in that root is found, by the same scan.
    const planted = join(tmp, "planted-canary.txt");
    writeFileSync(planted, `x${encodeURIComponent(PASS)}x`);
    assert.deepEqual(scan(tmp, [PASS]), [planted]);
    rmSync(planted);
    assert.deepEqual(scan(tmp, canaries), [], "child's temporary root");
    assert.deepEqual(scan(join(root, "state"), canaries), [], "tour state root");
    for (const c of canaries.flatMap(v => [v, encodeURIComponent(v)])) {
      assert.ok(!childErr.includes(c) && !childOut.includes(c), "child output");
      assert.ok(!serverOut.includes(c), "server output");
    }
    await runtime.signIn(caller, dry.job.id, { origin: s.origin, code: CODE });
    await phase(dry.job.id, j => j.phase === "checking" || j.phase === "failed");
    assert.equal(runtime.queue.get(caller.sessionId, dry.job.id)!.phase, "checking");
    // The signed-in session travels to the server only in the child's one signed-in message, and stays in memory.
    const sid = s.cookies().sid;
    assert.ok(sid);
    assert.deepEqual(childOut.split("\n").filter(l => l.includes(sid)).map(l => (JSON.parse(l) as { type: string }).type), ["signed-in"]);
    for (const c of [PASS, USER, ACCOUNT, CODE, sid]) {
      assert.ok(!childErr.includes(c) && !serverOut.includes(c), `${c === sid ? "session" : "login"} in output`);
      assert.deepEqual(scan(join(root, "state"), [c]), []);
    }
    for (const c of [PASS, USER, ACCOUNT, CODE]) assert.ok(!childOut.includes(c) && !childOut.includes(encodeURIComponent(c)));
    assert.equal(s.hits(`account=${ACCOUNT}`), 1);
  } finally {
    process.stdout.write = write.out; process.stderr.write = write.err;
    runtime.close(); s.close(); rmSync(root, { recursive: true, force: true });
  }
});

// A hash-routed app: one document at "/", its session checked by a fetch after load. Signed out, it
// sends itself to "#/login"; the sign-in fetch-POSTs, then a hash change shows the signed-in view.
async function hashApp() {
  let posts = 0, session = "";
  const app = `<!doctype html><html><head><style>body{margin:0;font:18px sans-serif}h1{margin:0 0 12px}</style></head><body><main id="app"></main><script>
    const app = document.getElementById("app");
    const show = async () => {
      const route = location.hash.replace(/^#/, "") || "/";
      const me = await fetch("/api/me");
      if (!me.ok && route !== "/login") { location.hash = "#/login"; return; }
      if (me.ok && route === "/login") { location.hash = "#/account"; return; }
      if (route === "/login") {
        app.innerHTML = '<form id="f"><label>Username <input name="username"></label><label>Password <input type="password" name="password" data-testid="password"></label><button>Sign in</button></form>';
        document.getElementById("f").addEventListener("submit", e => { e.preventDefault(); const f = e.target; fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: f.username.value, password: f.password.value }) }).then(r => { if (r.ok) location.hash = "#/account"; }); });
      } else app.innerHTML = route === "/other" ? "<h1>Other page</h1>" : "<h1>Your account</h1><p>Made-up account page.</p>";
    };
    addEventListener("hashchange", show); show();
  </script></body></html>`;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/api/me") { res.statusCode = session && (req.headers.cookie ?? "").includes(`sid=${session}`) ? 200 : 401; res.end("{}"); return; }
    if (url.pathname === "/api/login" && req.method === "POST") {
      posts++;
      const body = await new Promise<string>(r => { let b = ""; req.on("data", c => { b += c; }); req.on("end", () => r(b)); });
      const v = JSON.parse(body || "{}") as Record<string, string>;
      if (v.username !== USER || v.password !== PASS) { res.statusCode = 401; res.end(); return; }
      session = `s${Math.random()}`; res.setHeader("set-cookie", `sid=${session}; Path=/; HttpOnly`); res.end("{}"); return;
    }
    res.setHeader("content-type", "text/html"); res.end(app);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { origin, posts: () => posts, close: () => { server.closeAllConnections(); server.close(); } };
}

test("a hash-routed sign-in page (\"/#/login\") is signed in once; a signed-in view at another hash route never signs in again", { timeout: 120_000 }, async () => {
  const a = await hashApp();
  try {
    const s = script(a.origin, ["/#/account", "/#/other"]);
    s.signIn!.route = "/#/login";
    const { result, asked } = await record(s);
    assert.equal(failed(result), "recorded");
    assert.deepEqual(asked, ["username+password"], "one sign-in for both views and both sizes");
    assert.equal(a.posts(), 1);
    assert.equal((result as TourAttemptResult).signedIn, true);
  } finally { a.close(); }
});

test("a script without signIn never opens a sign-in route", { timeout: 120_000 }, async () => {
  const s = await site();
  try {
    const plain = script(s.origin, ["/settings/password"]); delete plain.signIn;
    assert.equal(failed((await record(plain)).result), "recorded");
    assert.equal(s.hits("GET /login"), 0);
  } finally { s.close(); }
});
