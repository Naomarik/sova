// record_tour look (§app.tours/look) in the installed browser against a made-up site, through the real
// runtime and runner (sandbox off, the attempt's own proxy): the signed-out sign-in page's boxes are listed;
// signed-in pages are listed at both sizes with onFirstScreen right for each; the look's sign-in is held for
// a following dry run with the same tourId (one sign-in POST, one card); nothing is captured or stored but
// the lists; a page's own writes are stopped as in a dry run; a failing page is noted and the look goes on.
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { normalizeTourScript, type TourJob, type TourScript, type TourSignIn } from "../../shared/tour";
import { stateView } from "../harness/state-view";
import type { TourLookAnswer, TourLookControl } from "./look";
import { TourRuntime, type TourNeedsYou } from "./runtime";
import type { TourToolCaller } from "./tools";

const USER = "made-up-look-user";
const PASS = "Made-Up-Look-Pass-4417";
const page = (body: string) => `<!doctype html><html><head><title>Made-up site</title><style>body{margin:0;font:18px sans-serif}h1{margin:0 0 12px}</style></head><body>${body}</body></html>`;

async function site() {
  const hits = new Map<string, number>();
  const hit = (key: string) => hits.set(key, (hits.get(key) ?? 0) + 1);
  let session = "";
  const signedIn = (req: IncomingMessage) => !!session && (req.headers.cookie ?? "").split(/;\s*/).includes(`sid=${session}`);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    hit(`${req.method} ${url.pathname}`);
    const html = (body: string) => { res.setHeader("content-type", "text/html"); res.end(page(body)); };
    const go = (to: string, set?: string) => { if (set) res.setHeader("set-cookie", set); res.statusCode = 302; res.setHeader("location", to); res.end(); };
    if (req.method === "POST" && url.pathname === "/login") {
      const body = await new Promise<string>(r => { let b = ""; req.on("data", c => { b += c; }); req.on("end", () => r(b)); });
      const v = Object.fromEntries(new URLSearchParams(body));
      if (v.username !== USER || v.password !== PASS) { html("<p>Wrong details</p>"); return; }
      session = `s${Math.random()}`;
      go("/account", `sid=${session}; Path=/; HttpOnly`); return;
    }
    if (req.method !== "GET") { res.end(); return; }
    if (url.pathname === "/login") {
      if (signedIn(req)) { go("/account"); return; }
      html(`<h1>Welcome back</h1><form method="post" action="/login"><label>Username <input name="username"></label><label>Password <input type="password" name="password" data-testid="password"></label><button>Sign in</button></form><a href="/forgot">Forgot your password?</a>`); return;
    }
    if (!signedIn(req)) { go("/login"); return; }
    if (url.pathname === "/account") {
      // A button 880 px down (on a desktop screen, below a phone's); a link off-site.
      html(`<h1>Your account</h1><nav><a href="/settings">Settings</a> <a href="/#/billing">Billing</a> <a href="https://elsewhere.example.test/x">Elsewhere</a></nav><button type="button" style="position:absolute;left:20px;top:880px;height:40px">Export</button>`); return;
    }
    // Its own analytics write on load (not the page the sign-in lands on: the sign-in's window admits a few writes there).
    if (url.pathname === "/settings") { html(`<h1>Settings</h1><label>Display name <input value="shown"></label><script>addEventListener("load", () => { fetch("/analytics", { method: "POST", body: "seen" }).catch(() => {}); });</script>`); return; }
    res.statusCode = 404; res.end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { origin, hits: (key: string) => hits.get(key) ?? 0, close: () => { server.closeAllConnections(); server.close(); } };
}
const role = (r: string, name: string) => ({ kind: "role" as const, role: r, name });
const signIn: TourSignIn = { route: "/login", username: role("textbox", "Username"), password: { kind: "testId", testId: "password" }, submit: role("button", "Sign in"), signedIn: role("heading", "Your account") };

function setup(origin: string) {
  const root = mkdtempSync(join(tmpdir(), "tour-look-"));
  const state = () => stateView([{ kind: "state", id: "sandbox", parentId: null, key: "sandbox", data: { version: 1, on: false, level: "workspace-write", enforcement: "none", backend: "test" } }]);
  const caller: TourToolCaller = { sessionId: "chat-look", sessionFile: join(root, "chat.jsonl"), cwd: root, state: state() };
  const cards: TourNeedsYou[] = [];
  const runtime = new TourRuntime({ root: join(root, "state"), onNeedsYou: e => { cards.push(e); },
    context: { canonical: p => p, snapshot: async () => ({ sessionId: caller.sessionId, sessionFile: caller.sessionFile, cwd: root, agentDir: join(root, "agent"), state: state(), held: { on: false, enforcement: "none" } }) },
    target: async () => ({ origin, assertCurrent: async () => {} }),
  });
  runtime.approvals.approve(origin);
  const phases = new Map<string, Set<string>>();
  runtime.queue.subscribe(j => { const s = phases.get(j.id) ?? new Set<string>(); s.add(j.phase); phases.set(j.id, s); });
  const settle = async (id: string, wanted: (j: TourJob) => boolean) => {
    for (let i = 0; i < 2400; i++) { const j = runtime.queue.get(caller.sessionId, id)!; if (wanted(j)) return j; await new Promise(r => setTimeout(r, 50)); }
    throw new Error(`job stayed ${runtime.queue.get(caller.sessionId, id)?.phase}`);
  };
  return { root, runtime, caller, cards, phases, settle, close: () => { runtime.close(); rmSync(root, { recursive: true, force: true }); } };
}
const done = (j: TourJob) => ["checking", "failed", "cancelled"].includes(j.phase);
const find = (controls: TourLookControl[] | undefined, match: Partial<TourLookControl>) => controls?.find(c => Object.entries(match).every(([k, v]) => (c as unknown as Record<string, unknown>)[k] === v));

test("look: the signed-out sign-in page's boxes, both sizes of each page with onFirstScreen, one card and one sign-in reused by the dry run, nothing captured, writes stopped", { timeout: 240_000 }, async () => {
  const s = await site();
  const f = setup(s.origin);
  try {
    const looked = await f.runtime.look!(f.caller, { source: { kind: "site", origin: s.origin }, signIn, pages: [{ route: "/account" }, { route: "/settings", actions: [{ op: "reveal", target: role("button", "Missing") }] }, { route: "/settings" }] }, "tour-look");
    assert.equal(looked.job.tourId, "tour-look");
    assert.match((looked.look as { next: string }).next, /status/);
    const parked = await f.settle(looked.job.id, j => j.phase === "needs-sign-in" || done(j));
    assert.equal(parked.phase, "needs-sign-in", JSON.stringify(parked.failure));
    await f.runtime.signIn(f.caller, looked.job.id, { origin: s.origin, username: USER, password: PASS });
    const finished = await f.settle(looked.job.id, done);
    assert.equal(finished.phase, "checking", JSON.stringify(finished.failure));
    const answer = (await f.runtime.status(f.caller, looked.job.id)).look as TourLookAnswer;
    assert.equal(answer.tourId, "tour-look");
    assert.match(answer.next, /tourId "tour-look"/);
    // The sign-in page, signed out: its real boxes and button.
    assert.equal(answer.signInPage?.route, "/login");
    assert.equal(answer.signInPage?.url, "/login");
    for (const c of [{ role: "textbox", name: "Username" }, { role: "textbox", name: "Password", input: "password" }, { role: "button", name: "Sign in" }, { role: "heading", name: "Welcome back" }]) assert.equal(find(answer.signInPage?.controls, c)?.matches, 1, `${JSON.stringify(c)} in ${JSON.stringify(answer.signInPage?.controls)}`);
    // Signed in, both sizes: the heading on the first screen at both, the button 880 px down only on the desktop's.
    const account = answer.pages[0]!;
    assert.equal(account.route, "/account");
    for (const size of ["desktop", "phone"] as const) {
      assert.equal(account[size]?.url, "/account");
      assert.deepEqual(find(account[size]?.controls, { role: "heading", name: "Your account" }), { role: "heading", name: "Your account", matches: 1, onFirstScreen: true, y: account[size]!.controls.find(c => c.name === "Your account")!.y, h: account[size]!.controls.find(c => c.name === "Your account")!.h });
      assert.equal(find(account[size]?.controls, { role: "button", name: "Export" })?.y, 880);
      assert.deepEqual(account[size]?.links, ["/settings", "/#/billing"], "same-origin links, hash routes included, never another site's");
    }
    assert.equal(find(account.desktop?.controls, { role: "button", name: "Export" })?.onFirstScreen, true);
    assert.equal(find(account.phone?.controls, { role: "button", name: "Export" })?.onFirstScreen, false);
    // A page whose action fails is noted, with nearby targets, and listed anyway; the next page is looked at.
    const failing = answer.pages[1]!;
    assert.match(failing.desktop?.problem?.message ?? "", /Target matched 0 visible controls/);
    assert.ok(find(failing.desktop?.controls, { role: "heading", name: "Settings" }), JSON.stringify(failing.desktop));
    assert.ok(find(answer.pages[2]!.phone?.controls, { role: "textbox", name: "Display name" }));
    assert.ok(!JSON.stringify(answer).includes(USER), "no login value in the answer");
    // Nothing captured or stored but the lists; the page's own writes stopped as in a dry run.
    const attempt = f.runtime.artifacts.read(f.caller.sessionId, looked.job.id)!;
    assert.equal(attempt.mode, "look"); assert.equal(attempt.manifest, undefined);
    const pictures = join(f.root, "state", "tour-private", f.caller.sessionId, looked.job.id, "pictures");
    assert.ok(!existsSync(pictures) || readdirSync(pictures).length === 0, "no picture written");
    assert.equal(s.hits("POST /analytics"), 0, "the page's own write never reached the site");
    assert.ok((finished.quietAborts ?? 0) > 0, "and was counted");
    await assert.rejects(f.runtime.record(f.caller, looked.job.id), /Run dry-run first/, "a look is never recorded");
    // The dry run with the look's tourId starts from its sign-in: no card, no second POST.
    const script: TourScript = { v: 1, title: "Account", summary: "The account page.", audience: "A reviewer", outcome: "See it.", source: { kind: "site", origin: s.origin }, signIn,
      chapters: [{ id: "main", title: "Main" }], steps: [{ id: "account", chapter: "main", title: "Account", summary: "The account.", views: [{ id: "view", title: "View", kind: "page", note: "", route: "/account", sizes: ["desktop", "phone"], actions: {}, marks: [{ target: role("heading", "Your account"), label: "Your account.", side: "right" }] }] }] } as TourScript;
    assert.ok(normalizeTourScript(script), "masks left out is fine");
    const dry = await f.runtime.dryRun(f.caller, script, "tour-look");
    const dried = await f.settle(dry.job.id, done);
    assert.equal(dried.phase, "checking", JSON.stringify(dried.failure));
    assert.ok(!f.phases.get(dry.job.id)?.has("needs-sign-in"), "the dry run never waited for a sign-in");
    assert.equal(f.cards.length, 1, "one sign-in card in all");
    assert.equal(s.hits("POST /login"), 1, "one sign-in POST in all");
  } finally { f.close(); s.close(); }
});

test("look with only a sign-in route lists that page signed out: no card, nothing typed or sent", { timeout: 120_000 }, async () => {
  const s = await site();
  const f = setup(s.origin);
  try {
    const looked = await f.runtime.look!(f.caller, { source: { kind: "site", origin: s.origin }, signInRoute: "/login", pages: [] });
    const finished = await f.settle(looked.job.id, done);
    assert.equal(finished.phase, "checking", JSON.stringify(finished.failure));
    const answer = (await f.runtime.status(f.caller, looked.job.id)).look as TourLookAnswer;
    assert.deepEqual(answer.pages, []);
    assert.equal(find(answer.signInPage?.controls, { role: "textbox", name: "Username" })?.matches, 1);
    assert.deepEqual(answer.signInPage?.links, ["/forgot"]);
    assert.equal(f.cards.length, 0);
    assert.equal(s.hits("POST /login"), 0);
  } finally { f.close(); s.close(); }
});
