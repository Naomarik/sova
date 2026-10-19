// In-place sign-in (§app.tours/recording), split from runner-signin.integration.test.ts for the runner's per-file
// time cap: an app that draws its sign-in form in place of any page, signed in up front, held sessions, the
// card before view 1, and mid-tour in-place sign-outs (N1–N5). Same fixtures, same assertions.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type TourAction, type TourSize } from "../../shared/tour";
import { type TourAttemptResult } from "./runner";
import { TourRuntime } from "./runtime";
import { stateView } from "../harness/state-view";
import type { TourJob } from "../../shared/tour";
import type { TourToolCaller } from "./tools";
import { TOUR_SIGN_IN_BOX_SIGNED_IN, TOUR_SIGN_IN_STALE } from "./runner-protocol";
import { PASS, USER, failed, pngPixel, record, script } from "./runner-signin.integration.fixture";

// A hash-routed app that draws its sign-in form IN PLACE of any page while signed out (200, no redirect,
// no 401, no sign-in route of its own), about 500 ms after its session check; signed in, any route draws
// its page after the same delay. `blank`: signed out it draws neither the form nor a signed-in page.
// Signed in, a page shows a green block (never on the form). `expireAtDocs`: the site ends the session as
// its nth document ("/") loads. `drawOnFillAtDoc`: on that document, filling the page's note box draws the
// sign-in form in place of the signed-in content (no request: a request after a fill is refused).
// `#/reauth`, signed in, draws only a password box named like the sign-in's, with no signed-in heading.
async function inPlaceApp(mode: { blank?: boolean; lostWhenSignedIn?: boolean; expireAtDocs?: number[]; drawOnFillAtDoc?: number } = {}) {
  let posts = 0, docs = 0, session = "";
  const app = (doc: number) => `<!doctype html><html><head><style>body{margin:0;font:18px sans-serif}h1{margin:0 0 12px}</style></head><body><main id="app"><p>Starting</p></main><script>
    const app = document.getElementById("app");
    const show = async () => {
      // Its sign-in route judges by the token the page kept, not by the server: signed in, it's a "no such page".
      if (${mode.lostWhenSignedIn ? "true" : "false"} && location.hash === "#/login" && localStorage.getItem("token")) { await new Promise(r => setTimeout(r, 500)); app.innerHTML = "<h1>That made-up page no longer exists.</h1>"; return; }
      const me = await fetch("/api/me");
      await new Promise(r => setTimeout(r, 500));
      if (!me.ok) {
        if (${mode.blank ? "true" : "false"}) { app.innerHTML = "<p>Still starting</p>"; return; }
        app.innerHTML = '<form id="f"><label>Username <input name="username"></label><label>Password <input type="password" name="password" data-testid="password"></label><button>Sign in</button></form>';
        document.getElementById("f").addEventListener("submit", e => { e.preventDefault(); const f = e.target; fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: f.username.value, password: f.password.value }) }).then(r => { if (!r.ok) return; localStorage.setItem("token", "made-up"); if (${mode.lostWhenSignedIn ? "true" : "false"} && location.hash === "#/login") location.hash = "#/dashboard"; else show(); }); });
        return;
      }
      if (location.hash === "#/reauth") { app.innerHTML = '<form><label>Confirm <input type="password" data-testid="password"></label></form>'; return; }
      app.innerHTML = '<h1>Your account</h1><div id="ok" style="position:absolute;left:0;top:200px;width:300px;height:40px;background:#00aa00"></div><p>Made-up page ' + (location.hash || "#/") + '</p><details style="position:absolute;left:400px;top:60px"><summary data-testid="more">More</summary><p>More detail</p></details><form style="position:absolute;left:20px;top:300px"><input aria-label="Note" data-note="1"></form>';
    };
    if (${mode.drawOnFillAtDoc === doc ? "true" : "false"}) {
      const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
      Object.defineProperty(HTMLInputElement.prototype, "value", { configurable: true, get() { return native.get.call(this); }, set(v) {
        native.set.call(this, v);
        if (this.dataset.note) { document.querySelector("h1")?.remove(); document.getElementById("ok")?.remove(); app.insertAdjacentHTML("beforeend", '<form style="position:absolute;left:20px;top:400px"><label>Username <input name="username"></label><label>Password <input type="password" name="password" data-testid="password"></label><button>Sign in</button></form>'); }
      } });
    }
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
    if (url.pathname === "/") { docs++; if (mode.expireAtDocs?.includes(docs)) session = "ended-by-the-site"; }
    res.setHeader("content-type", "text/html"); res.end(app(docs));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { origin, posts: () => posts, docs: () => docs, expire: () => { session = "ended-by-the-site"; }, close: () => { server.closeAllConnections(); server.close(); } };
}
const inPlace = (origin: string) => { const s = script(origin, ["/#/dashboard"]); s.signIn!.route = "/#/login"; return s; };

test("a form drawn in place of every signed-out page is signed in up front: one POST for both sizes, one capture per view and size, none of the sign-in", { timeout: 120_000 }, async () => {
  const a = await inPlaceApp();
  try {
    const { result, asked, stored } = await record(inPlace(a.origin), { dryRun: false });
    assert.equal(failed(result), "recorded");
    assert.deepEqual(asked, ["username+password"]);
    assert.equal(a.posts(), 1, "the phone size went on from the session the desktop size signed in");
    const r = result as TourAttemptResult;
    assert.equal(r.signedIn, true);
    assert.deepEqual([...r.assets.keys()].filter(f => f.startsWith("capture-")).sort(), ["capture-1-1-desktop.png", "capture-1-1-phone.png"], "views × sizes");
    assert.equal(a.docs(), 4, "per size: the sign-in route's load, then the view's own fresh load");
    // A session the tour holds: the up-front step sees the signed-in page and signs in no more.
    const again = await record(inPlace(a.origin), { storage: stored[0] });
    assert.equal(failed(again.result), "recorded");
    assert.deepEqual(again.asked, []);
    assert.equal(a.posts(), 1);
  } finally { a.close(); }
});

test("an up-front sign-in page showing neither the signed-in control nor the password box stops, typing nothing", { timeout: 120_000 }, async () => {
  const a = await inPlaceApp({ blank: true });
  try {
    const { result, asked } = await record(inPlace(a.origin));
    assert.match(failed(result), /showed neither its signed-in control nor its password box/);
    assert.deepEqual(asked, []);
    assert.equal(a.posts(), 0);
  } finally { a.close(); }
});

test("one sign-in POST per tour across its dry run and recording; it waits on the card before view 1 when it holds no login", { timeout: 240_000 }, async () => {
  const a = await inPlaceApp();
  const root = mkdtempSync(join(tmpdir(), "tour-upfront-"));
  const state = () => stateView([{ kind: "state", id: "sandbox", parentId: null, key: "sandbox", data: { version: 1, on: false, level: "workspace-write", enforcement: "none", backend: "test" } }]);
  const caller: TourToolCaller = { sessionId: "chat-up", sessionFile: join(root, "chat.jsonl"), cwd: root, state: state() };
  const runtime = new TourRuntime({ root: join(root, "state"),
    context: { canonical: p => p, snapshot: async () => ({ sessionId: caller.sessionId, sessionFile: caller.sessionFile, cwd: root, agentDir: join(root, "agent"), state: state(), held: { on: false, enforcement: "none" } }) },
    target: async () => ({ origin: a.origin, assertCurrent: async () => {} }),
  });
  const phase = async (id: string, wanted: (j: TourJob) => boolean) => {
    for (let i = 0; i < 2400; i++) { const j = runtime.queue.get(caller.sessionId, id)!; if (wanted(j)) return j; await new Promise(r => setTimeout(r, 50)); }
    throw new Error(`job stayed ${runtime.queue.get(caller.sessionId, id)?.phase}`);
  };
  try {
    runtime.approvals.approve(a.origin);
    const dry = await runtime.dryRun(caller, inPlace(a.origin), "tour-up");
    const parked = await phase(dry.job.id, j => j.phase === "needs-sign-in");
    assert.equal(parked.completed, 0); assert.equal(parked.stepId, undefined, "parked before view 1");
    await runtime.signIn(caller, dry.job.id, { origin: a.origin, username: USER, password: PASS });
    await phase(dry.job.id, j => j.phase === "checking" || j.phase === "failed");
    const rec = await runtime.record(caller, dry.job.id);
    assert.equal((await phase(rec.job.id, j => j.phase === "checking" || j.phase === "failed")).phase, "checking");
    assert.equal(a.posts(), 1, "dry run and recording, both sizes: one sign-in");
    // Control: the tour's session cleared between dry run and recording (its login kept) signs in once more.
    const dry2 = await runtime.dryRun(caller, inPlace(a.origin), "tour-up2", { [a.origin]: { username: USER, password: PASS } });
    await phase(dry2.job.id, j => j.phase === "checking" || j.phase === "failed");
    assert.equal(a.posts(), 2);
    runtime.signIns.clear(caller.sessionId, "tour-up2");
    runtime.signIns.setCredentials(caller.sessionId, "tour-up2", { [a.origin]: { username: USER, password: PASS } });
    const rec2 = await runtime.record(caller, dry2.job.id);
    assert.equal((await phase(rec2.job.id, j => j.phase === "checking" || j.phase === "failed")).phase, "checking");
    assert.equal(a.posts(), 3, "a cleared session costs exactly one more sign-in");
  } finally { runtime.close(); a.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a sign-in route that shows neither once signed in: a size holding the tour's session goes on; a held session the site ended stops at the first view", { timeout: 180_000 }, async () => {
  const a = await inPlaceApp({ lostWhenSignedIn: true });
  try {
    // First attempt: no session held, so the form shows up front; one sign-in, and the phone size goes on from it.
    const first = await record(inPlace(a.origin));
    assert.equal(failed(first.result), "recorded");
    assert.deepEqual(first.asked, ["username+password"]);
    assert.equal(a.posts(), 1, "the phone size went on from the held session without signing in again");
    assert.equal((first.result as TourAttemptResult).signedIn, true);
    // (a) A held session the site still honours: the route shows neither, the views are signed in: 0 POSTs.
    const held = await record(inPlace(a.origin), { storage: first.stored[0] });
    assert.equal(failed(held.result), "recorded");
    assert.deepEqual(held.asked, []);
    assert.equal(a.posts(), 1);
    // (b) The site ends that session: the route still shows neither (the page's own token), and the desktop
    // size's first view draws the form in place: stop, typing nothing.
    a.expire();
    const stale = await record(inPlace(a.origin), { storage: first.stored[0] });
    assert.match(failed(stale.result), /The tour's held sign-in no longer works, so recording stopped\. Record again to sign in\./);
    const where = (stale.result as { failure?: { size?: string; viewId?: string } }).failure;
    assert.deepEqual([where?.size, where?.viewId], ["desktop", "view-1"]);
    assert.deepEqual(stale.asked, []);
    assert.equal(a.posts(), 1, "nothing typed or sent");
    // Recording again with no held session (the server forgot it) signs in fresh up front: one more POST.
    const fresh = await record(inPlace(a.origin));
    assert.equal(failed(fresh.result), "recorded");
    assert.equal(a.posts(), 2);
  } finally { a.close(); }
});

// In-place mid-tour sign-out (§app.tours/recording). Per size the documents load: the sign-in route, then each
// view; desktop signs in at d1, so with two views the phone's route is d4 and its first view d5.
const inPlaceViews = (origin: string, routes: string[], actions?: Partial<Record<TourSize, TourAction[]>>) => {
  const s = script(origin, routes); s.signIn!.route = "/#/login";
  if (actions) for (const v of s.steps[0]!.views) if (v.kind === "page") v.actions = actions;
  return s;
};
const GREEN = [0x00, 0xaa, 0x00];
const captures = (r: TourAttemptResult) => [...r.assets.keys()].filter(f => f.startsWith("capture-")).sort();
const at = (r: TourAttemptResult | Error) => { const f = (r as { failure?: { size?: string; viewId?: string } }).failure; return [f?.size, f?.viewId]; };

test("N1 a session the site ends in place mid-tour: one silent re-sign-in on the sign-in route, both sizes recorded signed in, views × sizes captures", { timeout: 180_000 }, async () => {
  const a = await inPlaceApp({ expireAtDocs: [5] });
  try {
    const { result, asked } = await record(inPlaceViews(a.origin, ["/#/dashboard", "/#/other"]), { dryRun: false });
    assert.equal(failed(result), "recorded");
    assert.equal(a.posts(), 2, "the up-front sign-in, then exactly one re-sign-in");
    assert.equal(asked.length, 2);
    const r = result as TourAttemptResult;
    assert.deepEqual(captures(r), ["capture-1-1-desktop.png", "capture-1-1-phone.png", "capture-1-2-desktop.png", "capture-1-2-phone.png"], "views × sizes; neither the form nor the route captured");
    for (const file of captures(r)) assert.deepEqual(pngPixel(r.assets.get(file)!, 100, 220), GREEN, `${file}: signed-in content`);
    assert.equal(a.docs(), 8, "the expired view loaded twice, the route once more");
  } finally { a.close(); }
});

test("N2 a site that signs the recorder out in place again after the re-sign-in fails at the cap, nothing more typed", { timeout: 180_000 }, async () => {
  const a = await inPlaceApp({ expireAtDocs: [5, 7] });
  try {
    const { result, asked } = await record(inPlaceViews(a.origin, ["/#/dashboard", "/#/other"]), { dryRun: false });
    assert.match(failed(result), /The site signed the recorder out again, so recording stopped\./);
    assert.deepEqual(at(result), ["phone", "view-1"]);
    assert.equal(a.posts(), 2);
    assert.equal(asked.length, 2, "no third login asked for");
  } finally { a.close(); }
});

test("N3 a view showing the sign-in's password box while the sign-in route shows the recorder signed in stops, typing nothing at the view", { timeout: 120_000 }, async () => {
  const a = await inPlaceApp();
  try {
    const { result, asked } = await record(inPlaceViews(a.origin, ["/#/reauth"]));
    assert.ok(failed(result).startsWith(TOUR_SIGN_IN_BOX_SIGNED_IN), failed(result));
    assert.deepEqual(at(result), ["desktop", "view-1"]);
    assert.equal(a.posts(), 1, "only the up-front sign-in");
    assert.deepEqual(asked, ["username+password"]);
  } finally { a.close(); }
});

test("N4 one rule: a size that carried on from a held session stops as stale at a view's in-place form, before its actions, never signing in again", { timeout: 180_000 }, async () => {
  const a = await inPlaceApp({ lostWhenSignedIn: true });
  try {
    const first = await record(inPlace(a.origin));
    assert.equal(failed(first.result), "recorded");
    assert.equal(a.posts(), 1);
    a.expire();
    // The view opens a disclosure only the signed-in page has: checked after its actions only, the open would fail first.
    const s = inPlaceViews(a.origin, ["/#/dashboard"], { desktop: [{ op: "open", target: { kind: "testId", testId: "more" } }], phone: [] });
    const stale = await record(s, { storage: first.stored[0] });
    assert.ok(failed(stale.result).startsWith(TOUR_SIGN_IN_STALE), failed(stale.result));
    assert.deepEqual(at(stale.result), ["desktop", "view-1"]);
    assert.deepEqual(stale.asked, []);
    assert.equal(a.posts(), 1, "nothing typed or sent");
  } finally { a.close(); }
});

test("N5 a sign-out drawn in place after a view's fill is caught before capture: the recorder leaves the view, signs in again and records it signed in", { timeout: 180_000 }, async () => {
  // One view: desktop d1 route, d2 view; phone d3 route, d4 view, whose fill draws the form; d5 the route, expired.
  const a = await inPlaceApp({ drawOnFillAtDoc: 4, expireAtDocs: [5] });
  try {
    const fill = [{ op: "fill" as const, target: { kind: "role" as const, role: "textbox", name: "Note" }, value: "a made-up note" }];
    const { result, asked } = await record(inPlaceViews(a.origin, ["/#/dashboard"], { desktop: fill, phone: fill }), { dryRun: false });
    assert.equal(failed(result), "recorded");
    assert.equal(a.posts(), 2);
    assert.equal(asked.length, 2);
    const r = result as TourAttemptResult;
    assert.deepEqual(captures(r), ["capture-1-1-desktop.png", "capture-1-1-phone.png"]);
    for (const file of captures(r)) assert.deepEqual(pngPixel(r.assets.get(file)!, 100, 220), GREEN, `${file}: signed-in content`);
  } finally { a.close(); }
});
