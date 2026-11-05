// Run: pnpm test -- server/openai-login.test.ts. Settings → Accounts' OpenAI sign-in (§app.openai-login),
// on a fake ProviderSignIn that plays pi's login: no network, no port, files only under a mkdtemp dir.
// pi's own login (the browser route's port, the cancel that frees it) is sign-in.integration.test.ts.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { Hono } from "hono";
import type { ProviderSignIn, SignInHandlers, SignInMethod, SignInOutcome } from "../shared/harness";
import type { OpenAiAccountInfo, OpenAiLoginFlow } from "../shared/protocol";
import { emailOf, resetAuthStatusCache } from "./auth-status";
import { OpenAiLoginService, readAddress, registerOpenAiLoginRoutes } from "./openai-login";

const root = mkdtempSync(join(tmpdir(), "sova-openai-login-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
/** An access token shaped like OpenAI's: its profile claim holds the email. */
const token = (email: string) => `${b64({ alg: "none" })}.${b64({ "https://api.openai.com/profile": { email }, "https://api.openai.com/auth": { chatgpt_account_id: "acct-secret-id" } })}.sig-secret-part`;
const LINK = "https://auth.openai.com/oauth/authorize?client_id=x&state=state-123";

/** One sign-in pi would run: the test scripts each method's steps through `plan`. */
type Step = (h: SignInHandlers, signal: AbortSignal, store: () => void) => Promise<SignInOutcome>;
class FakeSignIn implements ProviderSignIn {
  calls: SignInMethod[] = [];
  signals: AbortSignal[] = [];
  signedOut = 0;
  constructor(private readonly authPath: string, private readonly plan: Partial<Record<SignInMethod, Step>>) {}
  store = (email = "ada@example.com") => {
    writeFileSync(this.authPath, JSON.stringify({ "openai-codex": { type: "oauth", access: token(email), refresh: "refresh-secret", expires: Date.now() + 3_600_000, accountId: "acct-secret-id" } }));
  };
  async signIn(provider: string, method: SignInMethod, h: SignInHandlers, signal: AbortSignal): Promise<SignInOutcome> {
    assert.equal(provider, "openai-codex");
    this.calls.push(method);
    this.signals.push(signal);
    const step = this.plan[method];
    if (!step) return { ok: false, error: "no plan" };
    return step(h, signal, () => this.store());
  }
  async signOut(provider: string): Promise<void> {
    assert.equal(provider, "openai-codex");
    this.signedOut++;
    writeFileSync(this.authPath, "{}");
  }
}

/** Resolves when `signal` aborts, as pi's login does: it returns cancelled. */
const untilAborted = (signal: AbortSignal) => new Promise<SignInOutcome>((resolve) => signal.addEventListener("abort", () => resolve({ ok: false, error: "Login cancelled", cancelled: true }), { once: true }));

let n = 0;
function setup(plan: Partial<Record<SignInMethod, Step>>, opts: { timeouts?: { flow?: number; shown?: number; finish?: number; settle?: number }; codexApp?: boolean } = {}) {
  resetAuthStatusCache();
  const dir = join(root, `case-${++n}`);
  mkdirSync(join(dir, ".codex"), { recursive: true });
  const paths = { claudeCreds: join(dir, "claude.json"), piAuth: join(dir, "auth.json"), codexAuth: join(dir, ".codex", "auth.json") };
  if (opts.codexApp) writeFileSync(paths.codexAuth, JSON.stringify({ tokens: { access_token: "codex-app-token" }, last_refresh: new Date().toISOString() }));
  const fake = new FakeSignIn(paths.piAuth, plan);
  const changes: string[] = [];
  const svc = new OpenAiLoginService({
    signIn: fake,
    paths: () => paths,
    timeouts: { shown: 2000, finish: 2000, settle: 2000, ...opts.timeouts },
    meshSharesLogins: () => true,
    apiKeysOnly: () => false,
    afterChange: (c) => { changes.push(c); },
  });
  return { svc, fake, paths, changes };
}

/** A code route that shows a code, then waits until `go` is called (the user entered it). */
function codeRoute() {
  let go!: () => void;
  const entered = new Promise<void>((resolve) => { go = resolve; });
  const step: Step = async (h, signal, store) => {
    h.onEvent({ type: "code", userCode: "ABCD-1234", url: "https://auth.openai.com/codex/device", expiresInMs: 15 * 60_000 });
    const r = await Promise.race([entered.then(() => "entered" as const), untilAborted(signal)]);
    if (r !== "entered") return r;
    store();
    return { ok: true };
  };
  return { step, go: () => go() };
}

/** A browser route: shows the link, asks for the address, and stores once one is given. */
const browserRoute: Step = async (h, signal, store) => {
  h.onEvent({ type: "url", url: LINK });
  const ask = new AbortController();
  signal.addEventListener("abort", () => ask.abort(), { once: true });
  try {
    await h.askAddress(ask.signal);
  } catch {
    return { ok: false, error: "Login cancelled", cancelled: true };
  }
  store();
  return { ok: true };
};

const until = async (check: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("OpenAI sign-in flow", () => {
  test("a code first: the dialog shows the code and link, and the done state carries the email", async () => {
    const code = codeRoute();
    const { svc, fake, changes } = setup({ code: code.step });
    const started = await svc.start();
    assert.equal(started.status, 200);
    const flow = started.body as Extract<OpenAiLoginFlow, { state: "code" }>;
    assert.equal(flow.state, "code");
    assert.equal(flow.userCode, "ABCD-1234");
    assert.equal(flow.url, "https://auth.openai.com/codex/device");
    assert.ok(flow.expiresAt > Date.now() && flow.expiresAt <= Date.now() + 15 * 60_000);
    assert.deepEqual(fake.calls, ["code"]);
    code.go();
    await until(() => svc.flowState()?.state === "done");
    assert.deepEqual(svc.flowState(), { state: "done", email: "ada@example.com" });
    await until(() => changes.length > 0);
    assert.deepEqual(changes, ["signed-in"]);
  });

  test("the status payload has the email and no other credential-derived field", async () => {
    const code = codeRoute();
    const { svc } = setup({ code: code.step });
    await svc.start();
    code.go();
    await until(() => svc.flowState()?.state === "done");
    const info = await svc.info();
    assert.equal(info.signedIn, true);
    assert.equal(info.email, "ada@example.com");
    assert.equal(typeof info.expiresAt, "number");
    assert.equal(info.expired, false);
    assert.deepEqual(Object.keys(info).sort(), ["apiKeysOnly", "codexAppSignedIn", "email", "expired", "expiresAt", "flow", "meshSharesLogins", "signedIn"]);
    const wire = JSON.stringify(info);
    for (const secret of ["refresh-secret", "acct-secret-id", "sig-secret-part", token("ada@example.com").split(".")[1]!]) {
      assert.ok(!wire.includes(secret), `the payload carries ${secret}`);
    }
  });

  test("signed out: not signed in, and the Codex app's own sign-in is a boolean", async () => {
    const { svc } = setup({}, { codexApp: true });
    const info = await svc.info();
    assert.deepEqual(info, { signedIn: false, codexAppSignedIn: true, meshSharesLogins: true, apiKeysOnly: false, flow: null });
    assert.ok(!JSON.stringify(info).includes("codex-app-token"));
  });

  test("one flow at a time", async () => {
    const code = codeRoute();
    const { svc } = setup({ code: code.step });
    await svc.start();
    const again = await svc.start();
    assert.equal(again.status, 409);
    await svc.cancel();
  });

  test("a refused code route turns into the browser route, which says why", async () => {
    const { svc, fake } = setup({
      code: async () => ({ ok: false, error: "OpenAI Codex device code login is not enabled", refused: true }),
      browser: browserRoute,
    });
    const started = await svc.start();
    const flow = started.body as Extract<OpenAiLoginFlow, { state: "browser" }>;
    assert.equal(flow.state, "browser");
    assert.equal(flow.url, LINK);
    assert.match(flow.refused ?? "", /didn't offer a sign-in code/);
    assert.ok(!JSON.stringify(flow).includes("not enabled"), "pi's own text stays on the server");
    assert.deepEqual(fake.calls, ["code", "browser"]);
    const done = await svc.answer({ text: "http://localhost:1455/auth/callback?code=c0de&state=state-123" });
    assert.deepEqual(done.body, { state: "done", email: "ada@example.com" });
  });

  test("an address that isn't the page's keeps the flow waiting, with a reason", async () => {
    const { svc } = setup({ browser: browserRoute });
    await svc.start({ method: "browser" });
    const noCode = await svc.answer({ text: "https://chatgpt.com/" });
    assert.equal((noCode.body as OpenAiLoginFlow).state, "browser");
    assert.match((noCode.body as { error?: string }).error ?? "", /isn't the address/);
    const other = await svc.answer({ text: "http://localhost:1455/auth/callback?code=c0de&state=someone-else" });
    assert.equal((other.body as OpenAiLoginFlow).state, "browser");
    assert.match((other.body as { error?: string }).error ?? "", /another sign-in/);
    const bad = await svc.answer({ text: "" });
    assert.equal(bad.status, 400);
    const done = await svc.answer({ text: "http://localhost:1455/auth/callback?code=c0de&state=state-123" });
    assert.equal((done.body as OpenAiLoginFlow).state, "done");
  });

  test("an answer with no browser route waiting is refused", async () => {
    const code = codeRoute();
    const { svc } = setup({ code: code.step });
    await svc.start();
    const r = await svc.answer({ text: "http://localhost:1455/auth/callback?code=c0de" });
    assert.equal(r.status, 409);
    await svc.cancel();
  });

  test("OpenAI calling back by itself moves the browser route to finishing", async () => {
    let finish!: () => void;
    const { svc } = setup({
      browser: async (h, signal, store) => {
        h.onEvent({ type: "url", url: LINK });
        const ask = new AbortController();
        void h.askAddress(ask.signal).catch(() => {});
        await new Promise<void>((resolve) => { finish = resolve; });
        ask.abort(); // the callback won
        await new Promise((r) => setTimeout(r, 20));
        store();
        return { ok: true };
      },
    });
    await svc.start({ method: "browser" });
    finish();
    await until(() => svc.flowState()?.state === "finishing");
    await until(() => svc.flowState()?.state === "done");
  });

  test("cancel aborts pi's login, waits for it to return and clears the flow; nothing is saved", async () => {
    let returned = false;
    const { svc, fake, paths } = setup({
      code: async (h, signal) => {
        h.onEvent({ type: "code", userCode: "C", url: "https://auth.openai.com/codex/device" });
        const r = await untilAborted(signal);
        await new Promise((resolve) => setTimeout(resolve, 30)); // pi closing its server
        returned = true;
        return r;
      },
    });
    await svc.start();
    const r = await svc.cancel();
    assert.equal(fake.signals[0]!.aborted, true);
    assert.equal(returned, true, "cancel answers only once pi's login returned");
    assert.equal((r.body as OpenAiAccountInfo).flow, null);
    assert.equal((r.body as OpenAiAccountInfo).signedIn, false);
    resetAuthStatusCache();
    assert.equal((await svc.info()).signedIn, false);
    void paths;
  });

  test("left alone until the timeout it ends itself, aborted, nothing saved", async () => {
    const { svc, fake } = setup({ code: async (h, signal) => { h.onEvent({ type: "code", userCode: "C", url: "u" }); return untilAborted(signal); } }, { timeouts: { flow: 60 } });
    const started = await svc.start();
    assert.ok((started.body as { expiresAt: number }).expiresAt <= Date.now() + 60);
    await until(() => svc.flowState()?.state === "expired");
    assert.equal(fake.signals[0]!.aborted, true);
    await svc.settled();
    assert.equal(svc.flowState()?.state, "expired", "a late return of pi's login changes nothing");
    assert.equal((await svc.info()).signedIn, false);
    const next = await svc.start();
    assert.equal(next.status, 200, "a new sign-in may start after it");
    await svc.cancel();
  });

  test("a failure says Sova's sentence, never pi's text", async () => {
    const { svc } = setup({ code: async (h) => { h.onEvent({ type: "code", userCode: "C", url: "u" }); return { ok: false, error: "OpenAI Codex token exchange failed (400): {\"access_token\":\"leak\"}" }; } });
    const started = await svc.start();
    void started;
    await until(() => svc.flowState()?.state === "failed");
    const flow = svc.flowState() as { error: string };
    assert.equal(flow.error, "OpenAI didn't complete the sign-in. Try again.");
  });

  test("sign out removes it through the harness and tells the model menu", async () => {
    const code = codeRoute();
    const { svc, fake, changes } = setup({ code: code.step });
    await svc.start();
    code.go();
    await until(() => svc.flowState()?.state === "done");
    await svc.cancel(); // the dialog closes
    const r = await svc.signOut();
    assert.equal(r.status, 200);
    assert.equal(fake.signedOut, 1);
    assert.equal((r.body as OpenAiAccountInfo).signedIn, false);
    await until(() => changes.includes("signed-out"));
  });

  test("the routes answer with no-store", async () => {
    const code = codeRoute();
    const { svc } = setup({ code: code.step });
    const app = new Hono();
    registerOpenAiLoginRoutes(app, svc);
    const get = await app.request("/api/settings/accounts/openai");
    assert.equal(get.status, 200);
    assert.equal(get.headers.get("cache-control"), "no-store");
    const start = await app.request("/api/settings/accounts/openai/login", { method: "POST", body: JSON.stringify({ method: "code" }), headers: { "content-type": "application/json" } });
    assert.equal(((await start.json()) as OpenAiLoginFlow).state, "code");
    const poll = await app.request("/api/settings/accounts/openai/login");
    assert.equal(((await poll.json()) as OpenAiLoginFlow).state, "code");
    const badMethod = await app.request("/api/settings/accounts/openai/login", { method: "POST", body: JSON.stringify({ method: "api-key" }), headers: { "content-type": "application/json" } });
    assert.equal(badMethod.status, 409, "a flow is running");
    const cancel = await app.request("/api/settings/accounts/openai/login", { method: "DELETE" });
    assert.equal(((await cancel.json()) as OpenAiAccountInfo).flow, null);
    const badMethod2 = await app.request("/api/settings/accounts/openai/login", { method: "POST", body: JSON.stringify({ method: "api-key" }), headers: { "content-type": "application/json" } });
    assert.equal(badMethod2.status, 400);
  });
});

describe("the pieces", () => {
  test("emailOf reads the profile claim and nothing else", () => {
    assert.deepEqual(emailOf(token("ada@example.com")), { email: "ada@example.com" });
    assert.deepEqual(emailOf("not-a-jwt"), {});
    assert.deepEqual(emailOf(`${b64({})}.${b64({ email: "top@level.com" })}.x`), {});
    assert.deepEqual(emailOf(`${b64({})}.${b64({ "https://api.openai.com/profile": { email: "not an email" } })}.x`), {});
    assert.deepEqual(emailOf(undefined), {});
  });

  test("readAddress reads a redirect URL or its query", () => {
    assert.deepEqual(readAddress("http://localhost:1455/auth/callback?code=abc&state=s1"), { code: "abc", state: "s1" });
    assert.deepEqual(readAddress("code=abc&state=s1"), { code: "abc", state: "s1" });
    assert.deepEqual(readAddress("https://chatgpt.com/"), {});
    assert.deepEqual(readAddress("just words"), {});
  });
});
