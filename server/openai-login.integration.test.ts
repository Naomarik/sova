// Run: pnpm test:int -- server/openai-login.integration.test.ts
// Settings → Accounts' OpenAI sign-in end to end on a throwaway server (§app.openai-login): the real
// routes, pi's own openai-codex login and logout, and pi's auth.json in the server's agent dir. OpenAI
// is the stand-in in openai-login.integration.fixture.ts, preloaded into the server: no network.
// - The code route: one flow at a time; once OpenAI approves, pi stores the sign-in beside what the
//   file already held, the account shows its email and no other string from the credential, the
//   model menu lists the ChatGPT models without a restart, and Sign Out removes only that sign-in.
// - The browser route, when OpenAI refuses the code: it says so, holds localhost:1455 while it waits,
//   cancel frees the port and saves nothing; a pasted address of another sign-in keeps it waiting; the
//   right address signs in, and the port is free afterwards.
// Nothing Sova shows quotes pi's terminal wording.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { OpenAiAccountInfo, OpenAiLoginFlow } from "../shared/protocol";
import { startHermeticServer, type HermeticServer } from "./testing/hermetic-server";
import { FAKE_ACCOUNT_ID, FAKE_EMAIL, FAKE_REFRESH, FAKE_USER_CODE, fakeAccessToken } from "./openai-login.integration.fixture";

const FIXTURE = resolve(import.meta.dirname, "openai-login.integration.fixture.ts");
const ROUTE = "/api/settings/accounts/openai";
/** pi's terminal wording (its prompts and instructions), never Sova's. */
const PI_WORDS = /browser window should open|Select OpenAI Codex|paste the authorization code|Device code login \(headless\)|OpenAI Codex/i;

async function boot(mode: "code" | "refuse"): Promise<HermeticServer & { approve: string }> {
  const approve = join(mkdtempSync(join(tmpdir(), "sova-openai-approve-")), "approve");
  const server = await startHermeticServer({ env: { BUN_OPTIONS: `--preload ${FIXTURE}`, FAKE_OPENAI_LOGIN: mode, FAKE_OPENAI_APPROVE: approve } });
  return Object.assign(server, { approve });
}

function client(server: HermeticServer) {
  const headers = { "content-type": "application/json", "x-sova-token": server.token };
  return async <T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T; raw: string }> => {
    const res = await fetch(`${server.base}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const raw = await res.text();
    return { status: res.status, body: (raw ? JSON.parse(raw) : null) as T, raw };
  };
}

const portFree = (port: number) => new Promise<boolean>((done) => {
  const probe = createServer();
  probe.once("error", () => done(false));
  probe.listen(port, "127.0.0.1", () => probe.close(() => done(true)));
});

async function until<T>(what: string, read: () => Promise<T>, ok: (v: T) => boolean, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`${what}: still ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const authOf = (server: HermeticServer) => JSON.parse(readFileSync(join(server.agentDir, "auth.json"), "utf8")) as Record<string, any>;
const codexModels = (raw: string) => (JSON.parse(raw) as { provider?: string; id?: string; ref?: string }[]).filter((m) => JSON.stringify(m).includes("openai-codex"));

/** No string of the stored credential but the email in anything the browser got. */
function assertNoCredential(raw: string, server: HermeticServer): void {
  const stored = authOf(server)["openai-codex"];
  for (const secret of [stored?.access, stored?.refresh, stored?.accountId, FAKE_REFRESH, FAKE_ACCOUNT_ID, fakeAccessToken()]) {
    if (typeof secret === "string" && secret) assert.ok(!raw.includes(secret), `the browser got a credential string: ${raw}`);
  }
  // Not the JWT's payload or signature either, in any part.
  for (const part of fakeAccessToken().split(".")) if (part.length > 8) assert.ok(!raw.includes(part), `a part of the access token reached the browser: ${raw}`);
}

test("the code route: one flow at a time, pi stores it, the email and nothing else shows, the model menu follows, Sign Out removes only it", { timeout: 180_000 }, async () => {
  const server = await boot("code");
  try {
    const api = client(server);
    // Something the file already held, which neither sign-in nor sign-out may touch.
    writeFileSync(join(server.agentDir, "auth.json"), JSON.stringify({ zai: { type: "api_key", key: "fake-zai-01" } }));
    const before = await api<OpenAiAccountInfo>("GET", ROUTE);
    assert.equal(before.status, 200);
    assert.equal(before.body.signedIn, false);
    assert.equal(before.body.codexAppSignedIn, false);
    assert.deepEqual(codexModels((await api("GET", "/api/models")).raw), [], "no ChatGPT models before the sign-in");

    const started = await api<OpenAiLoginFlow>("POST", `${ROUTE}/login`, {});
    assert.equal(started.status, 200, started.raw);
    const code = started.body as Extract<OpenAiLoginFlow, { state: "code" }>;
    assert.equal(code.state, "code", started.raw);
    assert.equal(code.userCode, FAKE_USER_CODE);
    assert.equal(new URL(code.url).host, "auth.openai.com");
    assert.ok(code.expiresAt > Date.now() && code.expiresAt <= Date.now() + 15 * 60_000 + 5_000, "ends itself within 15 minutes");
    assert.doesNotMatch(started.raw, PI_WORDS);

    const second = await api<{ error: string }>("POST", `${ROUTE}/login`, {});
    assert.equal(second.status, 409, "a second sign-in while one runs is refused");
    const third = await api<{ error: string }>("POST", `${ROUTE}/login`, { method: "browser" });
    assert.equal(third.status, 409, "whatever its method");
    assert.equal((await api<OpenAiLoginFlow>("GET", `${ROUTE}/login`)).body?.state, "code", "the first flow still runs");
    assert.equal(existsSync(join(server.agentDir, "auth.json.lock")), false, "pi holds no lock while it waits");

    writeFileSync(server.approve, "yes");
    const done = await until("the sign-in finishes", () => api<OpenAiLoginFlow>("GET", `${ROUTE}/login`), (r) => r.body?.state === "done" || r.body?.state === "failed");
    assert.deepEqual(done.body, { state: "done", email: FAKE_EMAIL });

    const stored = authOf(server);
    assert.equal(stored.zai?.key, "fake-zai-01", "the other sign-ins stay");
    assert.equal(stored["openai-codex"]?.type, "oauth");
    assert.equal(stored["openai-codex"]?.refresh, FAKE_REFRESH, "pi's own login stored it");
    assert.equal(stored["openai-codex"]?.accountId, FAKE_ACCOUNT_ID);

    const info = await api<OpenAiAccountInfo>("GET", ROUTE);
    assert.equal(info.body.signedIn, true);
    assert.equal(info.body.email, FAKE_EMAIL);
    assert.ok(typeof info.body.expiresAt === "number" && info.body.expiresAt > Date.now());
    assert.notEqual(info.body.expired, true);
    assertNoCredential(info.raw, server);
    assertNoCredential(done.raw, server);
    const allowed = new Set(["signedIn", "email", "expiresAt", "expired", "codexAppSignedIn", "meshSharesLogins", "apiKeysOnly", "flow"]);
    for (const key of Object.keys(info.body)) assert.ok(allowed.has(key), `unexpected field ${key} in the account payload`);

    // The model menu (GET /api/models, what the composer's picker reads) lists them now: no restart.
    const models = await until("the ChatGPT models join the menu", async () => codexModels((await api("GET", "/api/models")).raw), (m) => m.length > 0, 15_000);
    assert.ok(models.length > 0);

    const out = await api<OpenAiAccountInfo>("DELETE", ROUTE);
    assert.equal(out.status, 200, out.raw);
    assert.equal(out.body.signedIn, false);
    const after = authOf(server);
    assert.equal(after["openai-codex"], undefined, "Sign Out removed the sign-in");
    assert.equal(after.zai?.key, "fake-zai-01", "and only it");
    await until("the ChatGPT models leave the menu", async () => codexModels((await api("GET", "/api/models")).raw), (m) => m.length === 0, 15_000);
    assert.deepEqual(await server.stop(), [], "nothing outside the server's own agent dir changed");
  } finally {
    await server.stop();
  }
});

test("the browser route when OpenAI refuses the code: says why, holds 1455 while it waits, cancel frees it, the right address signs in", { timeout: 180_000 }, async () => {
  const server = await boot("refuse");
  try {
    const api = client(server);
    const free = await portFree(1455); // the Codex CLI may hold it: then pi waits on the paste alone

    const started = await api<OpenAiLoginFlow>("POST", `${ROUTE}/login`, {});
    const browser = started.body as Extract<OpenAiLoginFlow, { state: "browser" }>;
    assert.equal(browser.state, "browser", started.raw);
    assert.ok(browser.refused, "it says the code route was refused");
    assert.doesNotMatch(started.raw, PI_WORDS);
    assert.doesNotMatch(browser.refused!, /not enabled for this server|status \d{3}/, "Sova's sentence, not pi's");
    const link = new URL(browser.url);
    assert.equal(link.host, "auth.openai.com");
    const state = link.searchParams.get("state")!;
    assert.ok(state);
    if (free) assert.equal(await portFree(1455), false, "pi listens on localhost:1455 while it waits");

    const cancelled = await api<OpenAiAccountInfo>("DELETE", `${ROUTE}/login`);
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.flow, null);
    if (free) assert.equal(await portFree(1455), true, "cancel frees localhost:1455 before it answers");
    assert.equal(cancelled.body.signedIn, false, "nothing saved");

    // Again, to the end: a new flow starts at once after a cancel.
    const again = await api<OpenAiLoginFlow>("POST", `${ROUTE}/login`, {});
    const b2 = again.body as Extract<OpenAiLoginFlow, { state: "browser" }>;
    assert.equal(b2.state, "browser", again.raw);
    const state2 = new URL(b2.url).searchParams.get("state")!;
    assert.notEqual(state2, state, "a new sign-in, a new state");

    const stale = await api<OpenAiLoginFlow>("POST", `${ROUTE}/login/answer`, { text: `http://localhost:1455/auth/callback?code=fake-good-code&state=${state}` });
    assert.equal(stale.body?.state, "browser", "the first sign-in's address keeps it waiting");
    assert.ok((stale.body as { error?: string }).error);
    const junk = await api<OpenAiLoginFlow>("POST", `${ROUTE}/login/answer`, { text: "hello" });
    assert.equal(junk.body?.state, "browser");

    const ok = await api<OpenAiLoginFlow>("POST", `${ROUTE}/login/answer`, { text: `http://localhost:1455/auth/callback?code=fake-good-code&state=${state2}` });
    assert.deepEqual(ok.body, { state: "done", email: FAKE_EMAIL }, ok.raw);
    if (free) assert.equal(await portFree(1455), true, "the port is free once signed in");
    const info = await api<OpenAiAccountInfo>("GET", ROUTE);
    assert.equal(info.body.email, FAKE_EMAIL);
    assertNoCredential(info.raw, server);
    assert.deepEqual(await server.stop(), []);
  } finally {
    await server.stop();
  }
});
