// Run: pnpm test:int -- server/extension-key-auth.integration.test.ts
// An extension backend's own key at the doors (§app.extensions/backend-key), through the app as the
// listener hands requests to it (app.fetch with env.incoming, as server/caller-auth.test.ts does):
//   - the gate takes it in x-sova-token only, behind the host and cross-site rules, never on
//     /api/auth/* (however spelled), never as a cookie or a bearer, and unlock never trades it;
//   - every call it makes is recorded as `ext:<id>`, whatever x-sova-caller says;
//   - it never reaches another extension's backend, and the peer listener never reads it;
//   - no answer and no extension page carries it, and the Overseer can't read it or relay it;
//   - an extension can't shadow a core command.
import assert from "node:assert/strict";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server } from "node:http";
import { connect, createServer as netServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

const tmp = mkdtempSync(join(tmpdir(), "sova-ext-key-auth-"));
const agent = join(tmp, "agent");
process.env.PI_CODING_AGENT_DIR = agent;
process.env.SOVA_EXTENSIONS_FILE = join(tmp, "extensions.json");
for (const name of ["SOVA_TOKEN", "SOVA_AUTH", "HOST", "SOVA_ALLOWED_HOSTS", "SOVA_ALLOWED_ORIGINS", "SOVA_CALLER_KEY"]) delete process.env[name];
mkdirSync(join(agent, "sessions", "live"), { recursive: true });
const state = join(agent, "sova");
const dist = join(tmp, "dist");
mkdirSync(dist);
writeFileSync(join(dist, "index.html"), "<!doctype html><title>stub</title>");

const { buildApp } = await import("./app");
const { app } = buildApp({ extensionEntriesOf: async () => [] });
const { AUTH_COOKIE, initAuthToken, refuseUpgrade, setAuthPort, sovaToken, upgradeAllowed } = await import("./auth");
const { commandAudit } = await import("./command-audit");
const { extensionKeys } = await import("./extension-keys");
const { refuse } = await import("./extensions");
const { COMMANDS } = await import("../shared/commands-catalog");
const port = 47_931;
initAuthToken();
setAuthPort(port);
const self = `127.0.0.1:${port}`;
const token = sovaToken();

/** Two stand-in backends; each remembers the headers of its last request. */
const seen: Record<string, IncomingHttpHeaders | null> = { alpha: null, beta: null };
const backends: Server[] = [];
async function backend(id: string): Promise<number> {
  const s = createServer(async (req, res) => {
    for await (const _ of req) void _;
    if (req.url !== "/api/health") seen[id] = req.headers;
    res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
  });
  backends.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return (s.address() as { port: number }).port;
}
let manifest: object[] = [];
const install = (entries: object[]) => {
  manifest = entries;
  writeFileSync(process.env.SOVA_EXTENSIONS_FILE!, JSON.stringify({ version: 1, extensions: entries }));
};
const keyOf = (id: string) => readFileSync(extensionKeys.fileOf(id), "utf8").trim();
let alphaKey = "";
let betaKey = "";

before(async () => {
  const [a, b] = [await backend("alpha"), await backend("beta")];
  install([
    { id: "alpha", dist, api: `http://127.0.0.1:${a}`, commands: [{ name: "ping", label: "Ping" }] },
    { id: "beta", dist, api: `http://127.0.0.1:${b}` },
    // Its dist holds the keys: it must still never serve one.
    { id: "leaky", dist: state, api: `http://127.0.0.1:${b}` },
    // Named like a core family, with a core command's name.
    { id: "session", dist, api: `http://127.0.0.1:${b}`, commands: [{ name: "list", label: "List" }] },
  ]);
  extensionKeys.sync();
  alphaKey = keyOf("alpha");
  betaKey = keyOf("beta");
});
after(() => {
  for (const s of backends) s.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function send(method: string, path: string, headers: Record<string, string> = {}, body?: string, env: Record<string, unknown> = {}) {
  const sent: Record<string, string> = { Host: self, ...headers };
  const lower = Object.fromEntries(Object.entries(sent).map(([k, v]) => [k.toLowerCase(), v]));
  const incoming = { headers: lower, socket: { remoteAddress: "127.0.0.1" }, url: path, method };
  const res = await app.fetch(new Request(`http://${self}${path}`, { method, headers: sent, body }), { incoming, ...env });
  return { status: res.status, body: await res.text(), cookie: res.headers.get("set-cookie") };
}
const rows = async () => {
  await commandAudit.flush();
  return (await commandAudit.list({ limit: 1000 })).rows;
};
const upgradeReq = (headers: Record<string, string>, url = "/ws/events") => ({ url, headers: { host: self, ...headers } }) as unknown as IncomingMessage;

describe("the gate", () => {
  test("in x-sova-token the key opens what the token opens; anything else is a 401", async () => {
    assert.equal((await send("GET", "/api/commands", { "x-sova-token": alphaKey })).status, 200);
    assert.equal((await send("GET", "/api/extensions", { "x-sova-token": betaKey })).status, 200);
    assert.equal((await send("GET", "/api/commands")).status, 401);
    for (const bad of ["x".repeat(43), alphaKey.slice(1), `${alphaKey}x`]) assert.equal((await send("GET", "/api/commands", { "x-sova-token": bad })).status, 401, bad);
  });

  test("never as a cookie or a bearer, and unlock never trades it for the cookie", async () => {
    assert.equal((await send("GET", "/api/commands", { cookie: `${AUTH_COOKIE}=${alphaKey}` })).status, 401);
    assert.equal((await send("GET", "/api/commands", { authorization: `Bearer ${alphaKey}` })).status, 401);
    const u = await send("POST", "/api/auth/unlock", { "content-type": "application/json" }, JSON.stringify({ token: alphaKey }));
    assert.equal(u.status, 401);
    assert.equal(u.cookie, null);
  });

  test("/api/auth/* is 403 for a key, however it is spelled; the token still reaches it", async () => {
    for (const p of ["/api/auth/token", "/api/auth/pair", "/api/%61uth/token", "/api/auth/token/", "/API/auth/pair", "//api/auth/token", "/api/auth", "/api/%2e%2e/api/auth/token"]) {
      assert.equal((await send("GET", p, { "x-sova-token": alphaKey })).status, 403, p);
      assert.equal((await send("POST", p, { "x-sova-token": alphaKey })).status, 403, `POST ${p}`);
    }
    assert.equal((await send("GET", "/api/auth/token", { "x-sova-token": token })).status, 200);
    // A neighbour of the family is not it.
    assert.equal((await send("GET", "/api/authx", { "x-sova-token": alphaKey })).status, 404);
  });

  test("the host and cross-site rules stand before the key", async () => {
    assert.equal((await send("GET", "/api/commands", { Host: "evil.example", "x-sova-token": alphaKey })).status, 403);
    assert.equal((await send("GET", "/api/commands", { Origin: "http://evil.example", "x-sova-token": alphaKey })).status, 403);
    assert.equal((await send("GET", "/api/commands", { "Sec-Fetch-Site": "cross-site", "x-sova-token": alphaKey })).status, 403);
  });

  test("an uninstalled extension's key is a 401 at the next call", async () => {
    const before = manifest;
    install(manifest.filter((e) => (e as { id: string }).id !== "beta"));
    try {
      assert.equal((await send("GET", "/api/commands", { "x-sova-token": betaKey })).status, 401);
      assert.equal(upgradeAllowed(upgradeReq({ "x-sova-token": betaKey })), false);
    } finally {
      install(before);
    }
    assert.equal((await send("GET", "/api/commands", { "x-sova-token": betaKey })).status, 200, "back once reinstalled before any sync");
  });

  test("an upgrade with the key is let in and its socket held, and a refused one leaves nothing held", async () => {
    assert.equal(upgradeAllowed(upgradeReq({ "x-sova-token": alphaKey })), true);
    assert.equal(upgradeAllowed(upgradeReq({ cookie: `${AUTH_COOKIE}=${alphaKey}` })), false);
    // A real socket: the gate lets it in, then the route refuses it (an unknown extension), as
    // server/extensions.ts upgradeExtensionSocket does; nothing is held for it after.
    const srv = netServer();
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const accepted = new Promise<Socket>((r) => srv.once("connection", r));
    const client = connect((srv.address() as { port: number }).port, "127.0.0.1");
    client.on("error", () => {});
    client.resume(); // reads the refusal and its end, as a browser would
    const sock = await accepted;
    const held = extensionKeys.openSockets("alpha");
    assert.equal(refuseUpgrade(upgradeReq({ "x-sova-token": alphaKey }, "/ext/nope/ws/x"), sock), false);
    assert.equal(extensionKeys.openSockets("alpha"), held + 1);
    refuse(sock, 404, { error: "Unknown extension" });
    await new Promise((r) => sock.once("close", r));
    assert.equal(extensionKeys.openSockets("alpha"), held, "the refused socket is forgotten");
    client.destroy();
    srv.close();
  });
});

describe("the record", () => {
  test("a key's call is its extension's row, whatever x-sova-caller says; its upgrade is a 101 row", async () => {
    await send("GET", "/api/commands", { "x-sova-token": alphaKey, "x-sova-caller": "a-chat-key-0123456789abcdef", "x-sova-command": "ext.alpha.ping" });
    refuseUpgrade(upgradeReq({ "x-sova-token": alphaKey }), { destroyed: false, end() {}, once() {} } as never);
    const mine = (await rows()).filter((r) => r.caller === "ext:alpha");
    assert.ok(mine.some((r) => r.route === "/api/commands" && r.status === 200 && r.command === "ext.alpha.ping"), JSON.stringify(mine));
    assert.ok(mine.some((r) => r.route === "/ws/events" && r.status === 101));
    assert.ok(!(await rows()).some((r) => r.caller.startsWith("chat:")), "a key never passes for a chat");
  });

  test("a refused key leaves no row", async () => {
    const before = (await rows()).length;
    await send("GET", "/api/commands", { "x-sova-token": "y".repeat(43) });
    await send("GET", "/api/auth/token", { "x-sova-token": alphaKey });
    assert.equal((await rows()).length, before);
  });
});

describe("the peer listener never reads it", () => {
  test("the same answer with and without a key, and no row", async () => {
    const before = (await rows()).length;
    for (const path of ["/api/commands", "/api/extensions", "/api/no-such-route"]) {
      const peer = { meshPeer: { id: "peer" } };
      const bare = await send("GET", path, {}, undefined, peer);
      for (const k of [alphaKey, "z".repeat(43)]) {
        const withKey = await send("GET", path, { "x-sova-token": k }, undefined, peer);
        assert.equal(withKey.status, bare.status, path);
        assert.equal(withKey.body, bare.body, path);
      }
    }
    assert.equal((await rows()).length, before, "nothing recorded for the peer listener");
  });
});

describe("no other backend gets it", () => {
  test("alpha's key in x-sova-token or in a bearer never reaches beta's backend; beta's own Authorization does", async () => {
    await send("GET", "/ext/beta/api/echo", { "x-sova-token": alphaKey, authorization: `Bearer ${alphaKey}` });
    assert.ok(seen.beta, "the request reached beta");
    assert.equal(seen.beta!["x-sova-token"], undefined);
    assert.equal(seen.beta!.authorization, undefined);
    assert.ok(!JSON.stringify(seen.beta).includes(alphaKey));
    await send("GET", "/ext/beta/api/echo", { "x-sova-token": betaKey, authorization: "Bearer beta-own-thing" });
    assert.equal(seen.beta!.authorization, "Bearer beta-own-thing");
    assert.ok(!JSON.stringify(seen.beta).includes(betaKey), "not even its own key goes back to it");
  });
});

describe("never in a page", () => {
  test("no answer carries a key", async () => {
    for (const p of ["/api/extensions", "/api/commands", "/api/audit?limit=1000"]) {
      const r = await send("GET", p, { "x-sova-token": token });
      assert.equal(r.status, 200, p);
      for (const k of [alphaKey, betaKey]) assert.ok(!r.body.includes(k), p);
    }
  });

  test("an extension whose dist holds the keys, or links to one (symbolic or hard), never serves it", async () => {
    const name = extensionKeys.fileOf("alpha").slice(state.length + 1);
    const leak = await send("GET", `/ext/leaky/${name}`, { "x-sova-token": token });
    assert.equal(leak.status, 404);
    assert.ok(!leak.body.includes(alphaKey));
    assert.equal((await send("GET", "/ext/leaky/extension-key-hashes.json", { "x-sova-token": token })).status, 404);
    symlinkSync(extensionKeys.fileOf("alpha"), join(dist, "innocent.txt"));
    const linked = await send("GET", "/ext/alpha/innocent.txt", { "x-sova-token": token });
    assert.equal(linked.status, 404);
    assert.ok(!linked.body.includes(alphaKey));
    linkSync(extensionKeys.fileOf("alpha"), join(dist, "hard.txt"));
    const hard = await send("GET", "/ext/alpha/hard.txt", { "x-sova-token": token });
    assert.equal(hard.status, 404, "a hard link to a key");
    assert.ok(!hard.body.includes(alphaKey));
    writeFileSync(join(dist, "plain.txt"), "plain");
    linkSync(join(dist, "plain.txt"), join(dist, "plain-too.txt"));
    assert.equal((await send("GET", "/ext/alpha/plain-too.txt", { "x-sova-token": token })).status, 200, "a hard link to anything else serves");
    assert.equal((await send("GET", "/ext/alpha/index.html", { "x-sova-token": token })).status, 200, "its own files still serve");
  });

  test("the Overseer can't read or find a key file, and a key it meets elsewhere is redacted", async () => {
    const { overseerFileTools } = await import("./overseer-file-tools");
    const { SecretGuard, secretRules, SECRET_REFUSAL } = await import("./overseer-deny");
    const { Redactor, secretSources } = await import("./overseer-redact");
    const home = join(tmp, "home");
    mkdirSync(home, { recursive: true });
    const tools = Object.fromEntries(overseerFileTools(state, () => new SecretGuard(secretRules(home, agent, state))).map((t) => [t.name, t]));
    const call = async (name: string, params: Record<string, unknown>) => {
      try {
        const r = await tools[name]!.execute("tc", params as never, undefined, undefined, undefined as never);
        return (r.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("");
      } catch (err) {
        return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
      }
    };
    assert.equal(await call("read", { path: extensionKeys.fileOf("alpha") }), `ERROR: ${SECRET_REFUSAL}`);
    assert.ok(new SecretGuard(secretRules(home, agent, state)).isSecret(extensionKeys.fileOf("beta")));
    // A key planted where nothing is denied: its text never comes back.
    writeFileSync(join(state, "planted.txt"), `note: ${alphaKey}\n`);
    const r = new Redactor(secretSources(home, agent), {}).refresh();
    const out = r.redact(`saw ${alphaKey} and ${betaKey.slice(0, 20)}… here`);
    assert.ok(!out.includes(alphaKey), out);
    assert.ok(!out.includes(betaKey.slice(0, 20)), out);
    assert.match(out, /\[redacted\]/);
  });
});

test("an extension can't shadow a core command", async () => {
  const served = JSON.parse((await send("GET", "/api/commands", { "x-sova-token": alphaKey })).body) as { commands: Array<{ id: string }> };
  const ids = served.commands.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, "every id once");
  assert.ok(ids.includes("ext.session.list"));
  const core = COMMANDS.find((c) => c.id === "session.list");
  assert.deepEqual(served.commands.find((c) => c.id === "session.list"), JSON.parse(JSON.stringify(core)));
  assert.ok(served.commands.filter((c) => !c.id.startsWith("ext.")).every((c) => COMMANDS.some((k) => k.id === c.id)), "nothing but the core outside ext.*");
});
