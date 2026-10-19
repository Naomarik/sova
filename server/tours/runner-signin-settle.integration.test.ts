// The sign-in settle (§app.tours/recording), in the installed browser against a made-up hash-routed app that
// draws its sign-in form in place: an app that draws its form while it checks a session it holds counts as
// signed in (no card, nothing typed); sign-in boxes that vanish before they are filled count as signed in when
// the signed-in control shows, and otherwise stop as a sign-in failure naming the route, not a view.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { normalizeTourScript, type TourScript } from "../../shared/tour";
import { runTourAttempt, type TourAttemptResult } from "./runner";
import type { TourStorageState } from "./runner-protocol";
import type { TourRecordingContext } from "./sandbox";

const USER = "made-up-settle-user";
const PASS = "Made-Up-Settle-Pass-5521";
// `flash`: while it checks the session it draws its form at once, on every route, for that many ms past its
// usual 500 ms when signed in. `slowLogin`: the same on the sign-in route only. `vanish`: signed out, the form
// on the sign-in route disappears that many ms after it is drawn, leaving neither control.
// `set` changes the mode for the pages served next.
async function app(mode: { flash?: number; slowLogin?: number; vanish?: number } = {}) {
  let posts = 0, session = "";
  const html = () => `<!doctype html><html><head><style>body{margin:0;font:18px sans-serif}</style></head><body><main id="app"><p>Starting</p></main><script>
    const app = document.getElementById("app");
    const drawForm = () => {
      app.innerHTML = '<form id="f"><label>Username <input name="username"></label><label>Password <input type="password" name="password" data-testid="password"></label><button>Sign in</button></form>';
      document.getElementById("f").addEventListener("submit", e => { e.preventDefault(); const f = e.target; fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: f.username.value, password: f.password.value }) }).then(r => { if (r.ok) show(); }); });
    };
    const show = async () => {
      const checking = ${mode.flash ?? 0} || (location.hash === "#/login" ? ${mode.slowLogin ?? 0} : 0);
      if (checking) drawForm();
      const me = await fetch("/api/me");
      await new Promise(r => setTimeout(r, 500 + (me.ok ? checking : 0)));
      if (!me.ok) {
        drawForm();
        if (${mode.vanish ?? 0} && location.hash === "#/login") setTimeout(() => { app.innerHTML = "<p>Still starting</p>"; }, ${mode.vanish ?? 0});
        return;
      }
      app.innerHTML = '<h1>Your account</h1><p>Made-up page ' + (location.hash || "#/") + '</p>';
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
    res.setHeader("content-type", "text/html"); res.end(html());
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { origin, posts: () => posts, set: (next: typeof mode) => { mode = next; }, close: () => { server.closeAllConnections(); server.close(); } };
}
function script(origin: string): TourScript {
  const s: TourScript = {
    v: 1, title: "Made-up account", summary: "A signed-in page of a made-up app.", audience: "A reviewer", outcome: "See the account page.",
    source: { kind: "site", origin },
    signIn: { route: "/#/login", username: { kind: "role", role: "textbox", name: "Username" }, password: { kind: "testId", testId: "password" }, submit: { kind: "role", role: "button", name: "Sign in" }, signedIn: { kind: "role", role: "heading", name: "Your account" } },
    chapters: [{ id: "account", title: "Account" }],
    steps: [{ id: "account", chapter: "account", title: "Account", summary: "The account page.", views: [{ id: "view-1", title: "View 1", kind: "page", note: "", route: "/#/dashboard", sizes: ["desktop", "phone"], actions: {}, marks: [], masks: [] }] }],
  };
  assert.ok(normalizeTourScript(s), "fixture invalid");
  return s;
}
async function record(s: TourScript, options: { storage?: TourStorageState; answerAfterMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "tour-settle-"));
  const context: TourRecordingContext = { sessionId: "settle", sessionFile: join(root, "chat.jsonl"), cwd: root, agentDir: join(root, "agent"), sandbox: { on: false } };
  const asked: string[] = [];
  const stored: TourStorageState[] = [];
  try {
    const result: TourAttemptResult | Error = await runTourAttempt({ context, script: s, tourId: "settle", editionId: "settle-edition", dryRun: true, beforeContact: async () => {},
      ...(options.storage ? { signInStorage: options.storage } : {}),
      onSignIn: async need => { asked.push(need.fields.join("+")); if (options.answerAfterMs) await new Promise(r => setTimeout(r, options.answerAfterMs)); return { username: USER, password: PASS }; },
      onSignedIn: (_origin, state) => { stored.push(state); },
    }).catch((e: unknown) => e instanceof Error ? e : new Error(String(e)));
    return { result, asked, stored };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const failed = (r: TourAttemptResult | Error) => r instanceof Error ? `${r.message} ${JSON.stringify((r as { failure?: unknown }).failure ?? "")}` : "recorded";

test("an app that draws its form briefly while checking a held session records signed in: no card, no second sign-in", { timeout: 180_000 }, async () => {
  const a = await app({ flash: 900 });
  try {
    const first = await record(script(a.origin));
    assert.equal(failed(first.result), "recorded");
    assert.equal(a.posts(), 1, "the first attempt signs in once; its views' brief forms are no sign-out");
    const held = await record(script(a.origin), { storage: first.stored[0] });
    assert.equal(failed(held.result), "recorded");
    assert.deepEqual(held.asked, [], "no sign-in asked for: the form was the app checking its session");
    assert.equal(a.posts(), 1, "nothing typed or sent");
    assert.equal((held.result as TourAttemptResult).signedIn, true);
  } finally { a.close(); }
});

test("sign-in boxes that vanish before they are filled while the signed-in control shows count as signed in, nothing typed", { timeout: 180_000 }, async () => {
  const a = await app();
  try {
    const first = await record(script(a.origin));
    assert.equal(failed(first.result), "recorded");
    assert.equal(a.posts(), 1);
    a.set({ slowLogin: 3500 });
    // Its session check outlasts the settle, so a login is asked for; by the answer the form is gone.
    const held = await record(script(a.origin), { storage: first.stored[0], answerAfterMs: 4500 });
    assert.equal(failed(held.result), "recorded");
    assert.equal(a.posts(), 1, "nothing typed or sent");
  } finally { a.close(); }
});

test("sign-in boxes that vanish before they are filled with no signed-in control stop as a sign-in failure naming the route, not a view", { timeout: 180_000 }, async () => {
  const a = await app({ vanish: 3000 });
  try {
    const gone = await record(script(a.origin), { answerAfterMs: 4500 });
    assert.match(failed(gone.result), /The sign-in page \/#\/login stopped showing its sign-in boxes, so recording stopped\./);
    const f = (gone.result as { failure?: { stepId?: string; viewId?: string; guidance?: string } }).failure;
    assert.equal(f?.stepId, undefined); assert.equal(f?.viewId, undefined);
    assert.match(f?.guidance ?? "", /tell the user/);
    assert.equal(a.posts(), 0, "nothing typed or sent");
  } finally { a.close(); }
});
