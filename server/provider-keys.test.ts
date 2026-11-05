// Run: pnpm test -- server/provider-keys.test.ts. Settings → Accounts' API keys (§app/provider-keys): a pasted key
// is checked before anything is written, the keys list never carries a key, the reveal answers only the page in a
// browser on this computer, and a save or a removal spreads through login sync as a login or a logout. Every key
// here is fake, every provider check is a stub (no network), and every auth.json is in a scratch directory.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { Hono } from "hono";

const root = mkdtempSync(join(tmpdir(), "sova-provider-keys-"));
const agentDir = join(root, "agent");
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir; // before auth.ts computes its cookie name
delete process.env.SOVA_AUTH;
delete process.env.SOVA_TOKEN;
after(() => rmSync(root, { recursive: true, force: true }));

const { AUTH_COOKIE, CALLER_HEADER, sovaToken, TOKEN_HEADER } = await import("./auth");
const { RELAYED_HEADER } = await import("./mesh/proxy");
const { piProviderKeys } = await import("./harness/pi/sign-in");
const { keyProblem, ProviderKeysService, registerProviderKeyRoutes } = await import("./provider-keys");
const { CredentialSync } = await import("./sync/logins");
const { PiAuthStore } = await import("./sync/logins-stores");
type KeyCheck = import("./provider-keys").KeyCheck;

let seq = 0;
/** A scratch agent dir with its own auth.json, and a service over it whose checks answer `answer`. */
function rig(answer: (key: string) => KeyCheck | Promise<KeyCheck> = () => ({ result: "accepted" }), env: Record<string, string> = {}) {
  const dir = join(root, `rig${++seq}`);
  mkdirSync(dir, { recursive: true });
  const authPath = join(dir, "auth.json");
  const checked: string[] = [];
  const changed: string[] = [];
  const checker = async (key: string) => {
    checked.push(key);
    return answer(key);
  };
  const service = new ProviderKeysService({
    keys: piProviderKeys(() => authPath, () => join(dir, "models.json")),
    checkers: { deepseek: checker, zai: checker, anthropic: checker, openai: checker },
    env: () => env,
    statePath: () => join(dir, "provider-keys.json"),
    policy: () => ({ disabledProviders: [], disabledModels: [], subagentDisabledProviders: [], subagentDisabledModels: [] }),
    meshSharesLogins: () => false,
    signIns: async () => ({ claude: false, openai: false }),
    afterChange: (p) => void changed.push(p),
  });
  const auth = (): Record<string, any> => (existsSync(authPath) ? JSON.parse(readFileSync(authPath, "utf8")) : {});
  return { dir, authPath, service, checked, changed, auth };
}

describe("a pasted key is checked before it is saved (§app.provider-keys/check-before-save)", () => {
  test("refused: nothing is written, the saved key stays, and the answer names the refusal", async () => {
    const r = rig((key) => (key === "fake-old-key-1111" ? { result: "accepted" } : { result: "refused", status: 401 }));
    assert.equal((await r.service.set("deepseek", { key: "fake-old-key-1111" })).status, 200);
    const before = readFileSync(r.authPath, "utf8");
    const res = await r.service.set("deepseek", { key: "fake-new-key-2222" });
    assert.equal(res.status, 200);
    const body = res.body as { saved: boolean; refused?: string; row: { last4?: string; status: string } };
    assert.equal(body.saved, false);
    assert.match(body.refused ?? "", /DeepSeek refused this key \(HTTP 401\)/);
    assert.equal(readFileSync(r.authPath, "utf8"), before, "auth.json is untouched");
    assert.equal(body.row.last4, "1111", "the old key is still the one saved");
    assert.equal(body.row.status, "connected", "and its own check still stands");
    assert.deepEqual(r.checked, ["fake-old-key-1111", "fake-new-key-2222"], "checked with the pasted key, before any write");
    assert.deepEqual(r.changed, ["deepseek"], "a refused paste changes nothing downstream");
  });

  test("provider unreachable: the key is saved and reads Not checked yet; accepted reads Connected", async () => {
    const r = rig(() => ({ result: "unreachable", error: "timeout" }));
    const res = await r.service.set("zai", { key: "fake-zai-key-3333" });
    const body = res.body as { saved: boolean; row: { status: string; lastCheck?: { result: string; reason?: string } } };
    assert.equal(body.saved, true);
    assert.deepEqual(r.auth().zai, { type: "api_key", key: "fake-zai-key-3333" });
    assert.equal(body.row.status, "unchecked");
    assert.equal(body.row.lastCheck?.result, "unreachable");
    assert.match(body.row.lastCheck?.reason ?? "", /Couldn't reach Z\.ai: timeout/);

    const ok = rig();
    const saved = (await ok.service.set("anthropic", { key: "fake-ant-key-4444" })).body as { row: { status: string } };
    assert.equal(saved.row.status, "connected");
    assert.deepEqual(ok.changed, ["anthropic"], "the model menu and usage are told");
  });

  test("Other provider: saved without a check, reading Saved, not checked; no Test", async () => {
    const r = rig();
    const res = await r.service.set("openrouter", { key: "fake-or-key-5555" });
    const body = res.body as { saved: boolean; row: { status: string; checkable: boolean; tab: string } };
    assert.equal(body.saved, true);
    assert.deepEqual([body.row.status, body.row.checkable, body.row.tab], ["saved", false, "other"]);
    assert.deepEqual(r.checked, []);
    assert.equal((await r.service.test("openrouter")).status, 409);
    const info = await r.service.info(false);
    assert.ok(info.others.some((o) => o.id === "openrouter"), "OpenRouter is in the picker");
    assert.ok(!info.others.some((o) => ["anthropic", "openai", "deepseek", "zai", "ollama-cloud", "openai-codex"].includes(o.id)), "no tab's provider, no subscription-only one");
    assert.ok(info.rows.some((row) => row.provider === "openrouter" && row.last4 === "5555"));
  });

  test("a paste that can't be a key is refused before any check: blank, spaced, or a `!` command", async () => {
    const r = rig();
    for (const key of ["", "  ", "fake key", "!cat ~/.ssh/id_rsa", "x".repeat(5000)]) {
      assert.equal((await r.service.set("deepseek", { key })).status, 400, JSON.stringify(key.slice(0, 20)));
    }
    assert.deepEqual(r.checked, []);
    assert.equal(existsSync(r.authPath) && r.auth().deepseek !== undefined, false);
    assert.equal(keyProblem(" fake-key-ok "), null, "surrounding whitespace is trimmed, not refused");
  });

  test("a sign-in of another kind under the same id is never overwritten", async () => {
    const r = rig();
    writeFileSync(r.authPath, JSON.stringify({ anthropic: { type: "oauth", access: "fake-access", refresh: "fake-refresh", expires: 1 } }));
    assert.equal((await r.service.set("anthropic", { key: "fake-ant-key-6666" })).status, 409);
    assert.equal(r.auth().anthropic.type, "oauth");
    assert.equal(((await r.service.remove("anthropic")).body as { saved: boolean }).saved, false, "nothing to remove: the sign-in stays");
    assert.equal(r.auth().anthropic.type, "oauth");
  });
});

describe("environment keys (§app.provider-keys/key-tab)", () => {
  test("an environment-only key reads source env, is checked by Test, and is never read back or removed", async () => {
    const r = rig(() => ({ result: "accepted" }), { DEEPSEEK_API_KEY: "fake-env-key-7777" });
    let row = (await r.service.info(true)).rows.find((x) => x.provider === "deepseek")!;
    assert.deepEqual([row.source, row.status, row.saved, row.envSet, row.envName], ["env", "unchecked", false, true, "DEEPSEEK_API_KEY"]);
    assert.equal(row.last4, undefined, "the environment's key shows nothing of itself");
    row = (await r.service.test("deepseek")).body as typeof row;
    assert.deepEqual(r.checked, ["fake-env-key-7777"]);
    assert.equal(row.status, "connected");
    assert.equal((await r.service.reveal("deepseek")).status, 404);
    assert.equal(((await r.service.remove("deepseek")).body as { saved: boolean }).saved, false);
    // A saved key wins over it: Test then checks the saved one.
    await r.service.set("deepseek", { key: "fake-saved-key-8888" });
    row = (await r.service.test("deepseek")).body as typeof row;
    assert.deepEqual([row.source, row.last4], ["saved", "8888"]);
    assert.equal(r.checked.at(-1), "fake-saved-key-8888");
  });

  test("no key anywhere reads No key", async () => {
    const r = rig();
    const row = (await r.service.info(false)).rows.find((x) => x.provider === "zai")!;
    assert.deepEqual([row.source, row.status], ["none", "nokey"]);
  });
});

/** A Hono app over a rig's service, and a request as the main listener's socket would bring it. */
function routes(r: ReturnType<typeof rig>) {
  const app = new Hono();
  registerProviderKeyRoutes(app, r.service);
  const page = { cookie: `${AUTH_COOKIE}=${sovaToken()}` };
  const ask = (path: string, opts: { method?: string; headers?: Record<string, string>; body?: unknown; env?: object; from?: string } = {}) =>
    app.fetch(
      new Request(`http://127.0.0.1:4800${path}`, {
        method: opts.method ?? "GET",
        headers: { "content-type": "application/json", ...page, ...opts.headers },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      }),
      opts.env ?? { incoming: { socket: { remoteAddress: opts.from ?? "127.0.0.1" }, headers: opts.headers ?? {} } },
    );
  return { app, ask, page };
}

describe("the routes (§app.provider-keys/show-copy, /your-click)", () => {
  test("the keys list never carries a key value, and says whether this request may read one back", async () => {
    const r = rig();
    await r.service.set("deepseek", { key: "fake-secret-deepseek-9999" });
    await r.service.set("openrouter", { key: "fake-secret-openrouter-0000" });
    const { ask } = routes(r);
    const res = await ask("/api/settings/accounts/keys");
    assert.equal(res.headers.get("cache-control"), "no-store");
    const text = await res.text();
    assert.ok(!text.includes("fake-secret"), "no key value on the wire");
    assert.equal(JSON.parse(text).revealAllowed, true);
    const far = await (await ask("/api/settings/accounts/keys", { from: "100.64.0.7" })).json();
    assert.equal(far.revealAllowed, false, "another computer can't read one back");
  });

  test("the reveal answers only the page in a browser on this computer, never cached", async () => {
    const r = rig();
    await r.service.set("zai", { key: "fake-reveal-key-abcd" });
    const { ask } = routes(r);
    const reveal = (opts: Parameters<typeof ask>[1] = {}) => ask("/api/settings/accounts/keys/zai/reveal", { method: "POST", ...opts });
    const ok = await reveal();
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("cache-control"), "no-store");
    assert.deepEqual(await ok.json(), { key: "fake-reveal-key-abcd" });
    const refusals: [string, Parameters<typeof ask>[1]][] = [
      ["a LAN or tailnet address", { from: "192.168.1.20" }],
      ["tailscale serve on loopback (a proxy header)", { headers: { "x-forwarded-for": "100.64.0.9" } }],
      ["relayed by a mesh peer's proxy", { headers: { [RELAYED_HEADER]: "1" } }],
      ["the peer listener", { env: { incoming: { socket: { remoteAddress: "127.0.0.1" }, headers: {} }, meshPeer: { id: "peer" } } }],
      ["no socket (an in-process dispatch, a front-door relay)", { env: {} }],
      ["a socket with no address (a linked computer's relay)", { env: { incoming: { socket: {}, headers: {} } } }],
      ["a chat's key", { headers: { [CALLER_HEADER]: "chat-1" } }],
      ["a script holding the token", { headers: { [TOKEN_HEADER]: sovaToken() } }],
      ["no page cookie", { headers: { cookie: "" } }],
    ];
    for (const [who, opts] of refusals) {
      const res = await reveal(opts);
      assert.equal(res.status, 403, who);
      assert.equal(res.headers.get("cache-control"), "no-store", who);
      const text = await res.text();
      assert.ok(!text.includes("fake-reveal"), `${who}: no key`);
      assert.match(text, /Keys can only be read back on this computer/, who);
    }
  });

  test("save and remove pass only on the page's own request", async () => {
    const r = rig();
    const { ask } = routes(r);
    for (const headers of [{ [CALLER_HEADER]: "chat-1" }, { [TOKEN_HEADER]: sovaToken() }, { cookie: "" }] as Record<string, string>[]) {
      const put = await ask("/api/settings/accounts/keys/deepseek", { method: "PUT", headers, body: { key: "fake-agent-key-1234" } });
      assert.equal(put.status, 403);
      assert.equal(existsSync(r.authPath) && r.auth().deepseek !== undefined, false, "nothing saved");
    }
    const peer = await ask("/api/settings/accounts/keys/deepseek", { method: "PUT", body: { key: "fake-peer-key-1234" }, env: { incoming: {}, meshPeer: { id: "peer" } } });
    assert.equal(peer.status, 403);
    assert.equal((await ask("/api/settings/accounts/keys/deepseek", { method: "PUT", body: { key: "fake-page-key-1234" } })).status, 200);
    assert.equal(r.auth().deepseek.key, "fake-page-key-1234");
    assert.equal((await ask("/api/settings/accounts/keys/deepseek", { method: "DELETE", headers: { [CALLER_HEADER]: "chat-1" } })).status, 403);
    assert.equal(r.auth().deepseek.key, "fake-page-key-1234", "a chat removes nothing");
    const del = await ask("/api/settings/accounts/keys/deepseek", { method: "DELETE" });
    assert.equal(del.status, 200);
    assert.equal(r.auth().deepseek, undefined);
  });
});

describe("keys and login sync (§app.provider-keys/remove, §mesh.sync/logins)", () => {
  /** Two hosts whose pi auth.json files sync over an in-memory transport. */
  function mesh() {
    const hosts = ["a", "b"].map((id) => {
      const dir = join(root, `mesh${++seq}-${id}`);
      mkdirSync(dir, { recursive: true });
      return { id, dir, authPath: join(dir, "auth.json"), sync: null as unknown as InstanceType<typeof CredentialSync> };
    });
    for (const h of hosts) {
      h.sync = new CredentialSync({
        hostId: h.id,
        stores: [new PiAuthStore(h.authPath)],
        sidecarPath: join(h.dir, "login-sync.json"),
        peers: () =>
          hosts
            .filter((o) => o !== h)
            .map((o) => ({
              id: o.id,
              manifest: async () => structuredClone(o.sync.manifest()),
              entry: async (key: string) => {
                const got = await o.sync.entry(key as never);
                if (!got) throw new Error("404");
                return structuredClone(got);
              },
              push: async (body: unknown) => o.sync.receivePush(h.id, structuredClone(body) as never),
            })),
        debounceMs: 60_000,
      });
    }
    const converge = async () => {
      for (let i = 0; i < 3; i++) for (const h of hosts) await h.sync.syncAll();
    };
    const auth = (h: (typeof hosts)[number]): Record<string, any> => (existsSync(h.authPath) ? JSON.parse(readFileSync(h.authPath, "utf8")) : {});
    return { hosts, converge, auth };
  }

  test("a refused paste over a working key leaves the old key on both hosts and no removal; Remove spreads as a logout", async () => {
    const { hosts, converge, auth } = mesh();
    const [a, b] = hosts as [(typeof hosts)[0], (typeof hosts)[0]];
    const service = new ProviderKeysService({
      keys: piProviderKeys(() => a.authPath, () => join(a.dir, "models.json")),
      checkers: { deepseek: async (key) => (key.endsWith("good") ? { result: "accepted" } : { result: "refused", status: 401 }) },
      env: () => ({}),
      statePath: () => join(a.dir, "provider-keys.json"),
      policy: () => ({ disabledProviders: [], disabledModels: [], subagentDisabledProviders: [], subagentDisabledModels: [] }),
      signIns: async () => ({ claude: false, openai: false }),
    });
    assert.equal((await service.set("deepseek", { key: "fake-key-good" })).status, 200);
    await a.sync.observe("pi");
    await converge();
    assert.equal(auth(b).deepseek?.key, "fake-key-good", "the save reached the other host as a login");

    const refused = await service.set("deepseek", { key: "fake-key-bad" });
    assert.equal((refused.body as { saved: boolean }).saved, false);
    await a.sync.observe("pi");
    await converge();
    for (const h of [a, b]) {
      assert.equal(auth(h).deepseek?.key, "fake-key-good", `${h.id} keeps the old key`);
      assert.equal(h.sync.recordsSnapshot()["pi:deepseek" as never]?.tombstone, undefined, `${h.id}: no removal`);
    }

    assert.equal((await service.remove("deepseek")).status, 200);
    await a.sync.observe("pi");
    await converge();
    for (const h of [a, b]) {
      assert.equal(auth(h).deepseek, undefined, `${h.id}: removed`);
      assert.ok(h.sync.recordsSnapshot()["pi:deepseek" as never]?.tombstone, `${h.id}: a logout tombstone`);
    }
  });
});
