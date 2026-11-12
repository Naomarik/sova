// The Cloudflare Account token (§mesh.tunnel/account): its shape, its file, and the page-only routes, in process.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, describe, test } from "node:test";
import { Hono } from "hono";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-account-token-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent"), { recursive: true });
// A call as the page's: over a socket of the main listener, on a server with no sign-in (no cookie to show).
process.env.SOVA_AUTH = "off";

const tok = await import("./account-token");
const store = await import("../../public-links");
const cand = await import("../candidate");

after(() => rmSync(root, { recursive: true, force: true }));

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
/** The dashboard token's shape: base64 JSON with the account, tunnel and secret. Built at runtime (no literal secret). */
const TOKEN = b64({ a: "acct".padEnd(32, "0"), t: "tunnel".padEnd(36, "1"), s: "c2VjcmV0".padEnd(44, "x") });

function reset(): void {
  rmSync(tok.tokenFile(), { force: true });
  tok.dropCandidateToken();
  cand.dropCandidate();
  rmSync(store.publicLinksFile(), { force: true });
}

describe("the token's shape", () => {
  test("the dashboard token passes, bare or as its install line; anything else is refused without repeating it", () => {
    const url = TOKEN.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const passes: [string, string][] = [
      [TOKEN, TOKEN],
      [`  ${TOKEN}\n`, TOKEN],
      [`sudo cloudflared service install ${TOKEN}`, TOKEN],
      [`cloudflared tunnel run --token ${TOKEN}`, TOKEN],
      [url, url],
    ];
    for (const [paste, want] of passes) assert.deepEqual(tok.validAccountToken(paste), { ok: true, token: want }, paste);
    const refused: unknown[] = [
      undefined,
      42,
      "",
      "not a token at all",
      "x".repeat(60),
      b64({ a: "acct".padEnd(32, "0"), t: "tunnel".padEnd(36, "1") }),
      b64({ a: "", t: "tunnel".padEnd(36, "1"), s: "c2VjcmV0".padEnd(44, "x") }),
      b64([1, 2, 3, "padding".repeat(8)]),
      `${TOKEN} trailing`,
      TOKEN + " ".repeat(5000),
    ];
    for (const paste of refused) {
      const r = tok.validAccountToken(paste);
      assert.equal(r.ok, false, String(paste).slice(0, 40));
      assert.equal(!r.ok && r.error, tok.NOT_A_TOKEN);
    }
  });
});

describe("the file", () => {
  afterEach(reset);

  test("saved 0600 in a 0700 folder, read back, removed", () => {
    assert.equal(tok.readAccountToken(), null);
    tok.writeAccountToken(TOKEN);
    assert.equal(statSync(tok.tokenFile()).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(tok.tokenFile())).mode & 0o777, 0o700);
    assert.equal(tok.readAccountToken(), TOKEN);
    assert.equal(tok.hasAccountToken(), true);
    tok.deleteAccountToken();
    assert.equal(tok.hasAccountToken(), false);
  });

  test("a file holding no token reads as none", () => {
    mkdirSync(dirname(tok.tokenFile()), { recursive: true });
    writeFileSync(tok.tokenFile(), "TUNNEL_TOKEN='nope'\n");
    assert.equal(tok.readAccountToken(), null);
  });

  test("accountTunnel answers only for route account with its address and a token", () => {
    const account = { publicUrl: "https://share.example.com" };
    const cases: [route: "quick" | "account", address: boolean, token: boolean][] = [];
    for (const route of ["quick", "account"] as const) for (const address of [false, true]) for (const token of [false, true]) cases.push([route, address, token]);
    for (const [route, address, token] of cases) {
      reset();
      if (route === "account" && !address) continue; // a file can't hold route account without its address
      const r = store.patchPublicLinks({ route, ...(address ? { account } : {}) });
      assert.ok("file" in r, JSON.stringify(r));
      if (token) tok.writeAccountToken(TOKEN);
      const want = route === "account" && address && token ? { token: TOKEN, publicUrl: account.publicUrl } : null;
      assert.deepEqual(tok.accountTunnel(), want, `${route} address=${address} token=${token}`);
    }
  });
});

describe("kept from chats and the Overseer", () => {
  afterEach(reset);
  const REPO = join(import.meta.dirname, "..", "..", "..");

  test("every shipped sandbox policy and each backend's own list hide the tunnels folder", () => {
    for (const os of ["linux", "darwin"]) {
      const { hidden } = JSON.parse(readFileSync(join(REPO, "pi-config", "sandbox-policy", os, "policy.json"), "utf8"));
      assert.ok(hidden.includes("$AGENT_DIR/sova/tunnels"), os);
    }
    for (const file of ["linux-bwrap.ts", "darwin-seatbelt.ts"]) {
      const text = readFileSync(join(REPO, "pi-config", "extensions", "sandbox", "backends", file), "utf8");
      assert.ok(text.includes('join(a, "sova", "tunnels")'), file);
    }
  });

  test("the Overseer's file tools deny the folder, and its redactor takes the token out of what it reads", async () => {
    const { secretRules } = await import("../../overseer-deny");
    const { Redactor, secretSources } = await import("../../overseer-redact");
    assert.ok(secretRules().dirs.includes(dirname(tok.tokenFile())));
    tok.writeAccountToken(TOKEN);
    const unitEnv = join(dirname(tok.tokenFile()), "env", "sova-tunnel-x-share.env");
    const other = TOKEN.replace(/^.{8}/, "ZZZZZZZZ");
    mkdirSync(dirname(unitEnv), { recursive: true });
    writeFileSync(unitEnv, `TUNNEL_TOKEN='${other}'\n`);
    const pasted = TOKEN.replace(/^.{8}/, "YYYYYYYY");
    tok.writeAccountToken(pasted, tok.candidateTokenFile());
    const r = new Redactor(secretSources(join(root, "no-home"), process.env.PI_CODING_AGENT_DIR!), {}).refresh();
    const out = r.redact(`a ${TOKEN} b ${other} c ${pasted} d`);
    assert.ok(!out.includes(TOKEN) && !out.includes(other) && !out.includes(pasted), out);
    rmSync(dirname(unitEnv), { recursive: true, force: true });
  });
});

describe("the routes", () => {
  afterEach(reset);
  const calls: string[] = [];
  const control = async () => ({ stop: async (why: string) => calls.push(`stop ${why}`) });
  const app = () => {
    const a = new Hono();
    tok.mountAccountRoutes(a, control);
    return a;
  };
  const PAGE = { incoming: {} };
  const put = (body: unknown, headers: Record<string, string> = {}) => ({ method: "PUT", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const PATH = "/api/public-links/account-token";

  test("only the page saves or removes it; others change nothing", async () => {
    const callers: [string, Record<string, string>, object | undefined, number][] = [
      ["a script (token header)", { "x-sova-token": "t" }, PAGE, 403],
      ["no socket (in-process)", {}, undefined, 403],
      ["a peer", {}, { incoming: {}, meshPeer: { id: "p" } }, 404],
      ["relayed", { "x-sova-relayed": "1" }, PAGE, 404],
    ];
    tok.writeAccountToken(TOKEN);
    for (const [who, headers, env, status] of callers) {
      const a = app();
      const p = await a.request(PATH, put({ token: TOKEN }, headers), env);
      assert.equal(p.status, status, `${who} PUT`);
      if (status === 403) assert.equal((await p.json()).yourClick, true);
      const d = await a.request(PATH, { method: "DELETE", headers }, env);
      assert.equal(d.status, status, `${who} DELETE`);
      assert.equal(tok.readAccountToken(), TOKEN, `${who}: nothing changed`);
    }
  });

  test("a save answers only that it's saved; a bad paste is refused unsaved", async () => {
    const bad = await app().request(PATH, put({ token: "nope nope" }), PAGE);
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: tok.NOT_A_TOKEN });
    assert.equal(tok.hasAccountToken(), false);
    const ok = await app().request(PATH, put({ token: TOKEN }), PAGE);
    assert.equal(ok.status, 200);
    const text = await ok.text();
    assert.deepEqual(JSON.parse(text), { hasToken: true });
    assert.ok(!text.includes(TOKEN.slice(0, 20)), "the token is never echoed back");
    assert.equal(tok.readAccountToken(), TOKEN);
    assert.equal(readFileSync(tok.tokenFile(), "utf8"), `TUNNEL_TOKEN='${TOKEN}'\n`);
  });

  test("a new token waits beside the saved one while Account runs or a setup waits for Verify; nothing restarts; Verify promotes it, Cancel drops it", async () => {
    const OTHER = b64({ a: "acct".padEnd(32, "0"), t: "tunnel".padEnd(36, "2"), s: "b3RoZXI=".padEnd(44, "y") });
    const account = { publicUrl: "https://share.example.com" };
    for (const route of ["quick", "account"] as const)
      for (const pending of [false, true]) {
        reset();
        calls.length = 0;
        store.patchPublicLinks({ route, account });
        tok.writeAccountToken(TOKEN);
        const live = readFileSync(tok.tokenFile());
        if (pending) cand.saveCandidate({ route: "account", account: { publicUrl: "https://new.example.com" } }, { version: 1, route: "account", account: { publicUrl: "https://new.example.com" } });
        const r = await app().request(PATH, put({ token: OTHER }), PAGE);
        assert.deepEqual(await r.json(), { hasToken: true });
        const waits = route === "account" || pending;
        const at = `${route} pending=${pending}`;
        assert.equal(tok.readAccountToken(), waits ? TOKEN : OTHER, `${at}: the saved token`);
        if (waits) assert.deepEqual(readFileSync(tok.tokenFile()), live, `${at}: the live token file is byte-identical`);
        assert.equal(tok.readCandidateToken(), OTHER, `${at}: the candidate runs on the new one`);
        assert.equal(tok.hasCandidateToken(), waits, at);
        assert.equal(tok.accountTunnel()?.token ?? null, route === "account" ? (waits ? TOKEN : OTHER) : null, `${at}: today's tunnel keeps its token`);
        assert.deepEqual(calls, [], `${at}: nothing restarts`);
        if (waits) {
          assert.equal(statSync(tok.candidateTokenFile()).mode & 0o777, 0o600);
          tok.dropCandidateToken();
          assert.equal(tok.readAccountToken(), TOKEN, `${at}: Cancel keeps the saved one`);
          assert.equal(tok.readCandidateToken(), TOKEN, `${at}: no candidate token: the saved one`);
          await app().request(PATH, put({ token: OTHER }), PAGE);
          tok.promoteCandidateToken();
          assert.equal(tok.readAccountToken(), OTHER, `${at}: Verify promotes it`);
          assert.equal(tok.hasCandidateToken(), false, at);
        }
      }
  });

  test("removing it drops both tokens and stops a running Account tunnel; other routes leave tunnels alone", async () => {
    for (const route of ["quick", "account"] as const) {
      reset();
      calls.length = 0;
      store.patchPublicLinks({ route, account: { publicUrl: "https://share.example.com" } });
      tok.writeAccountToken(TOKEN);
      tok.writeAccountToken(TOKEN, tok.candidateTokenFile());
      const d = await app().request(PATH, { method: "DELETE" }, PAGE);
      assert.deepEqual(await d.json(), { hasToken: false });
      assert.equal(tok.hasAccountToken(), false);
      assert.deepEqual(calls, route === "account" ? ["stop token removed"] : [], route);
    }
  });
});
