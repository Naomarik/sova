// Run: pnpm test -- server/mesh/localapi-endpoint.test.ts
// How a host reaches its own Tailscale (localapi-endpoint.ts, localapi.ts), in-process: a stand-in
// LocalAPI that answers as the Mac app does (Host local-tailscaled.sock, Basic auth ":"+key, 401
// "auth required" without it), reached through node:http's real request path with each connection
// fed to it in-process (setLocalApiConnectForTest); the Mac's files and lsof are faked through
// setLocalApiEndpointDeps. The same over real 127.0.0.1 and unix sockets: the integration sibling.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { after, afterEach, beforeEach, describe, test } from "node:test";
import type { MeshCandidate } from "../../shared/protocol";
import { duplexPair } from "./duplex-pair-test-fixtures";

const tmp = mkdtempSync(join(tmpdir(), "sova-localapi-endpoint-"));
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
mkdirSync(join(tmp, "agent", "sessions", "live"), { recursive: true });

const { DEFAULT_TAILSCALE_SOCKET, EndpointError, forgetLocalApiEndpoint, localApiEndpoint, setLocalApiEndpointDeps } = await import("./localapi-endpoint");
const { getIdentity, localApiIdentity, setLocalApiConnectForTest } = await import("./localapi");
const { callerNode } = await import("./gate");

// The Mac's messages, as agreed (§mesh.peers/tailscale-on-mac).
const MAC = {
  missing: "Sova can't find Tailscale on this Mac. Install the Tailscale app from tailscale.com and sign in.",
  notRunning: "Tailscale isn't running on this Mac. Open the Tailscale app and connect.",
  notAdmin: "Only an administrator account on this Mac can ask Tailscale who's connected. Run Sova from an administrator account.",
  refused: "Tailscale on this Mac refused Sova's request. Quit and reopen the Tailscale app.",
  slow: "Tailscale on this Mac didn't answer in time. Try again.",
};

// ---- the stand-in LocalAPI ----------------------------------------------------------------------

const BIG_USER = "9007199254740993"; // above 2^53: JSON.parse alone would round it and lose the login
const STATUS = `{"BackendState":"Running","Self":{"ID":"nSelfA1CNTRL","UserID":${BIG_USER},"HostName":"a","DNSName":"a.tail.example.","OS":"macOS","Online":true,"TailscaleIPs":["100.64.0.1"]},"Peer":{"nodekey:b":{"ID":"nPeerB2CNTRL","UserID":${BIG_USER},"HostName":"b","DNSName":"b.tail.example.","OS":"macOS","Online":false,"TailscaleIPs":["100.64.0.2"]}},"User":{"${BIG_USER}":{"ID":${BIG_USER},"LoginName":"me@tail.example"}}}`;
const WHOIS = `{"Node":{"ID":9007199254740995,"StableID":"nPeerB2CNTRL","Name":"b.tail.example.","Tags":[]},"UserProfile":{"ID":${BIG_USER},"LoginName":"me@tail.example"}}`;
const B_ADDR = "100.64.0.2:41641";

interface Api {
  /** The key a request must carry (TCP, as the Mac app); none: a socket, as tailscaled's. */
  key?: string;
  mode: "ok" | "slow" | "refuse" | "whois-fails" | "error-answer" | "not-json";
  seen: Array<{ url: string; host?: string; authorization?: string }>;
}
const byPort = new Map<number, Api>();
const bySocket = new Map<string, Api>();
/** Every connection opened, in order: "127.0.0.1:<port>" or a socket path. */
const connections: string[] = [];
let onConnect: ((where: string) => void) | null = null;

const serveTcp = (port: number, key: string, mode: Api["mode"] = "ok"): Api => {
  const api: Api = { key, mode, seen: [] };
  byPort.set(port, api);
  return api;
};
const serveSocket = (path: string, mode: Api["mode"] = "ok"): Api => {
  const api: Api = { mode, seen: [] };
  bySocket.set(path, api);
  return api;
};
const basic = (key: string) => `Basic ${Buffer.from(`:${key}`).toString("base64")}`;

const server = createServer((req, res) => {
  const api = (req.socket as unknown as { fakeApi: Api }).fakeApi;
  api.seen.push({ url: req.url ?? "", host: req.headers.host, authorization: req.headers.authorization });
  const send = (status: number, body: string) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(body);
  };
  if (req.headers.host !== "local-tailscaled.sock") return send(400, "bad Host");
  if (api.key !== undefined && req.headers.authorization !== basic(api.key)) return send(401, "auth required\n");
  const url = new URL(req.url ?? "/", "http://x");
  if (api.mode === "error-answer") return send(500, "boom");
  if (api.mode === "not-json") return send(200, "<html>");
  if (url.pathname === "/localapi/v0/status") return send(200, STATUS);
  if (url.pathname === "/localapi/v0/whois") {
    if (api.mode === "whois-fails") return send(500, "whois broke");
    return url.searchParams.get("addr") === B_ADDR ? send(200, WHOIS) : send(404, "no match for IP:port");
  }
  send(404, "not found");
});

const asSocket = (s: Duplex) => Object.assign(s, { setTimeout: () => s, setNoDelay: () => s, setKeepAlive: () => s, ref: () => s, unref: () => s });

/** node:http's createConnection: the stand-in at that port or socket, as a real dial would find it. */
function connect(opts: { socketPath?: string; port?: number | string }): Duplex {
  const [client, served] = duplexPair();
  asSocket(client);
  asSocket(served);
  const where = opts.socketPath ?? `127.0.0.1:${opts.port}`;
  connections.push(where);
  onConnect?.(where);
  const api = opts.socketPath !== undefined ? bySocket.get(opts.socketPath) : byPort.get(Number(opts.port));
  if (!api || api.mode === "refuse") {
    const code = opts.socketPath !== undefined && !api ? "ENOENT" : "ECONNREFUSED";
    queueMicrotask(() => client.destroy(Object.assign(new Error(`connect ${code} ${where}`), { code, syscall: "connect" })));
    return client;
  }
  if (api.mode === "slow") {
    // Never answers: what fires is the request's own timeout, as on a socket that stays quiet.
    setImmediate(() => client.emit("timeout"));
    return client;
  }
  Object.assign(served, { fakeApi: api });
  server.emit("connection", served);
  return client;
}

// ---- the Mac's files and lsof -------------------------------------------------------------------

interface AppFiles {
  port: string;
  key: string;
  linkUid?: number;
  linkKind?: "link" | "file";
  keyUid?: number;
  keyMode?: number;
  keyError?: "EACCES";
}
interface MacState {
  app?: AppFiles;
  /** IPNExtension's `lsof -F` output; absent: lsof exits 1 (no such process). */
  lsof?: string;
  /** Whether Homebrew's tailscaled socket exists. */
  brew?: boolean;
}
let mac: MacState = {};
const BREW = "/var/run/tailscaled.socket";
/** Every call discovery made, in order. */
const calls: string[] = [];
const count = (kind: string) => calls.filter((c) => c.startsWith(`${kind} `)).length;

const info = (kind: "link" | "file" | "socket", uid: number, mode: number) => ({ uid, mode, isFile: () => kind === "file", isSymbolicLink: () => kind === "link", isSocket: () => kind === "socket" });
const fsError = (code: string, p: string) => Object.assign(new Error(`${code}: lstat '${p}'`), { code });
const keyFile = (app: AppFiles) => `/Library/Tailscale/sameuserproof-${app.port}`;

const fakeMac = {
  uid: () => 501,
  lstat: async (p: string) => {
    calls.push(`lstat ${p}`);
    const app = mac.app;
    if (app && p === "/Library/Tailscale/ipnport") return info(app.linkKind ?? "link", app.linkUid ?? 0, 0o120755);
    if (app && p === keyFile(app)) return info("file", app.keyUid ?? 0, app.keyMode ?? 0o100640);
    if (mac.brew && p === BREW) return info("socket", 0, 0o140666);
    throw fsError("ENOENT", p);
  },
  readlink: async (p: string) => {
    calls.push(`readlink ${p}`);
    if (mac.app && p === "/Library/Tailscale/ipnport") return mac.app.port;
    throw fsError("ENOENT", p);
  },
  readFile: async (p: string) => {
    calls.push(`readFile ${p}`);
    const app = mac.app;
    if (!app || p !== keyFile(app)) throw fsError("ENOENT", p);
    if (app.keyError) throw fsError(app.keyError, p);
    return `${app.key}\n`;
  },
  execFile: async (file: string, args: string[], opts: { timeout: number }) => {
    calls.push(`execFile ${file} ${args.join(" ")} timeout=${opts.timeout}`);
    if (mac.lsof === undefined) throw Object.assign(new Error("Command failed: lsof"), { code: 1 });
    return mac.lsof;
  },
  brewSocket: BREW,
};

const undo: Array<() => void> = [];
const asMac = (env: Record<string, string | undefined> = {}) => undo.push(setLocalApiEndpointDeps({ platform: "darwin", env, ...fakeMac }));
const asLinux = (env: Record<string, string | undefined> = {}) => undo.push(setLocalApiEndpointDeps({ platform: "linux", env, ...fakeMac }));

beforeEach(() => {
  mac = {};
  calls.length = 0;
  connections.length = 0;
  byPort.clear();
  bySocket.clear();
  onConnect = null;
  forgetLocalApiEndpoint();
  undo.push(setLocalApiConnectForTest(connect as never));
});
afterEach(() => {
  while (undo.length) undo.pop()!();
});
after(async () => {
  (await import("./index")).stopMesh();
  rmSync(tmp, { recursive: true, force: true });
});

const failure = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected a failure");
};
const key = () => `key-${randomUUID().slice(0, 8)}`;
const APP_CALLS = (app: AppFiles) => ["lstat /Library/Tailscale/ipnport", "readlink /Library/Tailscale/ipnport", `lstat ${keyFile(app)}`, `readFile ${keyFile(app)}`];
const LSOF_CALL = "execFile /usr/sbin/lsof -n -a -u501 -c IPNExtension -F timeout=2000";

// ---- Linux, and the override ---------------------------------------------------------------------

describe("Linux and SOVA_TAILSCALE_SOCKET", () => {
  test("Linux with no override: tailscaled's own socket, with no file read and no program started", async () => {
    asLinux();
    mac = { app: { port: "61001", key: key() }, lsof: "", brew: true }; // there, and never looked at
    const api = serveSocket(DEFAULT_TAILSCALE_SOCKET);
    assert.deepEqual(await localApiEndpoint(), { kind: "socket", path: DEFAULT_TAILSCALE_SOCKET });
    const status = await localApiIdentity.status();
    assert.equal(status.self.nodeId, "nSelfA1CNTRL");
    assert.equal(status.peers[0]!.login, "me@tail.example", "a UserID above 2^53 still names its user");
    assert.equal((await localApiIdentity.whois(B_ADDR))?.nodeId, "nPeerB2CNTRL");
    assert.equal(await localApiIdentity.whois("100.64.0.9:41641"), null, "whois 404: no such caller");
    assert.deepEqual(api.seen.map((s) => [s.host, s.authorization]), [["local-tailscaled.sock", undefined], ["local-tailscaled.sock", undefined], ["local-tailscaled.sock", undefined]]);
    assert.deepEqual(calls, []);
  });

  test("Linux keeps tailscaled's own wording, byte for byte, and never retries", async () => {
    asLinux();
    assert.equal(await failure(localApiIdentity.status()), `tailscaled unreachable: connect ENOENT ${DEFAULT_TAILSCALE_SOCKET}`);
    serveSocket(DEFAULT_TAILSCALE_SOCKET, "refuse");
    assert.equal(await failure(localApiIdentity.status()), `tailscaled unreachable: connect ECONNREFUSED ${DEFAULT_TAILSCALE_SOCKET}`);
    serveSocket(DEFAULT_TAILSCALE_SOCKET, "slow");
    assert.equal(await failure(localApiIdentity.status()), "tailscaled did not answer in time");
    serveSocket(DEFAULT_TAILSCALE_SOCKET, "error-answer");
    assert.equal(await failure(localApiIdentity.whois(B_ADDR)), "tailscaled whois: 500 boom");
    serveSocket(DEFAULT_TAILSCALE_SOCKET, "not-json");
    assert.equal(await failure(localApiIdentity.status()), "tailscaled status: not JSON");
    assert.equal(connections.length, 5, "one connection per request");
    assert.deepEqual(calls, []);
  });

  test("SOVA_TAILSCALE_SOCKET wins on Linux and on a Mac, and nothing else is looked at", async () => {
    const override = join(tmp, "override.sock");
    asLinux({ SOVA_TAILSCALE_SOCKET: override });
    assert.deepEqual(await localApiEndpoint(), { kind: "socket", path: override });
    undo.pop()!();
    asMac({ SOVA_TAILSCALE_SOCKET: override });
    mac = { app: { port: "61001", key: key() }, lsof: "", brew: true };
    serveTcp(61001, mac.app!.key);
    assert.deepEqual(await localApiEndpoint(), { kind: "socket", path: override });
    assert.equal(await failure(localApiIdentity.status()), MAC.missing, "on a Mac, a Mac's words");
    serveSocket(override, "refuse");
    assert.equal(await failure(localApiIdentity.status()), MAC.notRunning);
    serveSocket(override);
    assert.equal((await localApiIdentity.status()).self.nodeId, "nSelfA1CNTRL");
    assert.deepEqual(connections, [override, override, override], "never the app's port, and no retry");
    assert.deepEqual(calls, []);
  });
});

// ---- the tailscale.com app ------------------------------------------------------------------------

describe("Tailscale's app from tailscale.com", () => {
  test("its port on 127.0.0.1 with its key, read again for every request", async () => {
    asMac();
    const app: AppFiles = { port: "61001", key: key() };
    mac = { app };
    const api = serveTcp(61001, app.key);
    assert.deepEqual(await localApiEndpoint(), { kind: "tcp", port: 61001, token: app.key, source: "app" });
    const status = await localApiIdentity.status();
    assert.equal(status.peers[0]!.nodeId, "nPeerB2CNTRL");
    assert.equal(status.peers[0]!.login, "me@tail.example");
    assert.deepEqual(await localApiIdentity.whois(B_ADDR), { nodeId: "nPeerB2CNTRL", name: "b.tail.example", tags: [], login: "me@tail.example" });
    assert.equal(await localApiIdentity.whois("100.64.0.9:41641"), null);
    assert.deepEqual(
      api.seen.map((s) => s.url),
      ["/localapi/v0/status", "/localapi/v0/whois?addr=100.64.0.2%3A41641", "/localapi/v0/whois?addr=100.64.0.9%3A41641"],
    );
    for (const s of api.seen) {
      assert.equal(s.host, "local-tailscaled.sock");
      assert.equal(s.authorization, basic(app.key));
    }
    assert.deepEqual(connections, ["127.0.0.1:61001", "127.0.0.1:61001", "127.0.0.1:61001"]);
    assert.deepEqual(calls, [...APP_CALLS(app), ...APP_CALLS(app), ...APP_CALLS(app), ...APP_CALLS(app)], "the files are read for each request (and the first look)");
  });

  test("the stand-in refuses a request without the right key: Tailscale refused, after one fresh look", async () => {
    asMac();
    const first = key();
    mac = { app: { port: "61001", key: first } };
    const api = serveTcp(61001, key());
    assert.equal(await failure(localApiIdentity.status()), MAC.refused);
    assert.equal(count("readlink"), 2, "one fresh look");
    assert.equal(api.seen.length, 1, "it found the same key: nothing new to retry");
    // The fresh look finds a new key, refused too: one retry, then no more.
    api.seen.length = 0;
    const second = key();
    onConnect = () => {
      if (mac.app!.key === first) mac.app = { port: "61001", key: second };
    };
    assert.equal(await failure(localApiIdentity.status()), MAC.refused);
    assert.deepEqual(
      api.seen.map((s) => s.authorization),
      [basic(first), basic(second)],
    );
  });

  test("files that aren't root's, or a key others may write, are passed over and the key never read", async () => {
    asMac();
    const cases: Array<[string, Partial<AppFiles>]> = [
      ["link not root's", { linkUid: 501 }],
      ["ipnport not a link", { linkKind: "file" }],
      ["key not root's", { keyUid: 501 }],
      ["key group-writable", { keyMode: 0o100660 }],
      ["key world-writable", { keyMode: 0o100642 }],
      ["port 0", { port: "0" }],
      ["port past 65535", { port: "65536" }],
      ["six digits", { port: "123456" }],
      ["not a number", { port: "61a01" }],
      ["a path", { port: "../x" }],
    ];
    for (const [what, files] of cases) {
      calls.length = 0;
      mac = { app: { port: "61001", key: key(), ...files } };
      serveTcp(Number(mac.app!.port) || 61001, mac.app!.key);
      const err = await localApiEndpoint().then(
        () => null,
        (e: unknown) => e,
      );
      assert.ok(err instanceof EndpointError && err.reason === "missing", what);
      assert.equal(count("readFile"), 0, `${what}: the key is never read`);
      assert.ok(calls.includes(LSOF_CALL) && calls.includes(`lstat ${BREW}`), `${what}: the next kinds are tried`);
      assert.equal(await failure(localApiIdentity.status()), MAC.missing, what);
      mac.brew = true;
      assert.deepEqual(await localApiEndpoint(), { kind: "socket", path: BREW }, `${what}: Homebrew's socket instead`);
      forgetLocalApiEndpoint();
    }
    assert.deepEqual(connections, [], "nothing was dialed");
  });

  test("a key this account can't read: only an administrator can ask, unless another kind answers", async () => {
    asMac();
    mac = { app: { port: "61001", key: key(), keyError: "EACCES" } };
    serveTcp(61001, mac.app!.key);
    const err = await localApiEndpoint().catch((e: unknown) => e);
    assert.ok(err instanceof EndpointError && err.reason === "not-admin");
    assert.equal(await failure(localApiIdentity.status()), MAC.notAdmin);
    assert.ok(calls.includes(LSOF_CALL), "the App Store app is still looked for");
    mac.brew = true;
    serveSocket(BREW);
    assert.equal((await localApiIdentity.status()).self.nodeId, "nSelfA1CNTRL");
    assert.deepEqual(connections, [BREW]);
  });

  test("a key refused once: one fresh look picks up the app's new port and key", async () => {
    asMac();
    const before: AppFiles = { port: "61001", key: key() };
    const restarted: AppFiles = { port: "61002", key: key() };
    mac = { app: before };
    const old = serveTcp(61001, key()); // the app restarted on this port with another key
    const fresh = serveTcp(61002, restarted.key);
    onConnect = (where) => {
      if (where === "127.0.0.1:61001") mac.app = restarted;
    };
    assert.equal((await localApiIdentity.status()).self.nodeId, "nSelfA1CNTRL");
    assert.deepEqual([old.seen.length, fresh.seen.length, count("readlink")], [1, 1, 2]);
    assert.equal(fresh.seen[0]!.authorization, basic(restarted.key));
    await localApiIdentity.status();
    assert.deepEqual([old.seen.length, fresh.seen.length, count("readlink")], [1, 2, 3], "the next request goes to the new port");
  });

  test("a refused connection once: one fresh look picks up the app's new port", async () => {
    asMac();
    const restarted: AppFiles = { port: "61002", key: key() };
    mac = { app: { port: "61001", key: key() } };
    serveTcp(61002, restarted.key);
    onConnect = (where) => {
      if (where === "127.0.0.1:61001") mac.app = restarted;
    };
    assert.equal((await localApiIdentity.status()).self.nodeId, "nSelfA1CNTRL");
    assert.deepEqual(connections, ["127.0.0.1:61001", "127.0.0.1:61002"]);
  });
});

// ---- stale files, the App Store app, Homebrew -------------------------------------------------------

describe("when the app isn't answering, the next kind", () => {
  test("the app's files with nothing on its port: Homebrew's socket answers instead, and is kept", async () => {
    asMac();
    mac = { app: { port: "61001", key: key() }, brew: true };
    const brew = serveSocket(BREW);
    assert.equal((await localApiIdentity.status()).self.nodeId, "nSelfA1CNTRL");
    assert.deepEqual(connections, ["127.0.0.1:61001", BREW]);
    assert.equal(brew.seen[0]!.authorization, undefined, "the app's key goes to the app's port only");
    const reads = count("readlink");
    await localApiIdentity.status();
    assert.deepEqual(connections, ["127.0.0.1:61001", BREW, BREW]);
    assert.equal(count("readlink"), reads, "kept: no fresh look while it answers");
    bySocket.delete(BREW);
    mac.brew = false;
    assert.equal(await failure(localApiIdentity.status()), MAC.missing, "the socket is gone");
    serveTcp(61001, mac.app!.key);
    assert.equal((await localApiIdentity.status()).self.nodeId, "nSelfA1CNTRL", "forgotten after the failure: the app again");
  });

  test("the app's files with nothing on its port and no other kind: Tailscale isn't running", async () => {
    asMac();
    mac = { app: { port: "61001", key: key() } };
    assert.equal(await failure(localApiIdentity.status()), MAC.notRunning);
    assert.deepEqual(connections, ["127.0.0.1:61001"], "the fresh look passed the same port over");
    serveTcp(61001, mac.app!.key, "refuse");
    mac.brew = true;
    serveSocket(BREW, "refuse");
    assert.equal(await failure(localApiIdentity.status()), MAC.notRunning, "the socket refuses too");
  });

  test("nothing installed: Sova can't find Tailscale, after each kind in order", async () => {
    asMac();
    assert.equal(await failure(localApiIdentity.status()), MAC.missing);
    assert.deepEqual(calls, ["lstat /Library/Tailscale/ipnport", LSOF_CALL, `lstat ${BREW}`]);
    assert.deepEqual(connections, []);
  });

  test("the App Store app: its port and key from lsof, kept until a request fails", async () => {
    asMac();
    const storeKey = ["2ae2ec9e", "0aa20057", "84f1"].join("");
    const lsof = (port: number, k: string) =>
      ["p4242", "cIPNExtension", "f5", "n/dev/null", `n/Users/x/Library/Group Containers/ABCDE12345.io.tailscale.ipn.macos/sameuserproof-${port}-${k}`, ""].join("\n");
    mac = { lsof: lsof(61577, storeKey) };
    assert.deepEqual(await localApiEndpoint(), { kind: "tcp", port: 61577, token: storeKey, source: "appstore" });
    assert.deepEqual(calls, ["lstat /Library/Tailscale/ipnport", LSOF_CALL]);
    assert.deepEqual(await localApiEndpoint(), { kind: "tcp", port: 61577, token: storeKey, source: "appstore" });
    assert.equal(count("execFile"), 1, "kept");
    const api = serveTcp(61577, storeKey);
    assert.equal((await localApiIdentity.status()).self.nodeId, "nSelfA1CNTRL");
    assert.equal(api.seen[0]!.authorization, basic(storeKey));
    assert.equal(count("execFile"), 1);
    // The extension restarted on another port and key: the refused request looks again, once.
    byPort.delete(61577);
    const next = key();
    mac.lsof = lsof(61580, next);
    serveTcp(61580, next);
    assert.equal((await localApiIdentity.status()).self.nodeId, "nSelfA1CNTRL");
    assert.deepEqual(connections, ["127.0.0.1:61577", "127.0.0.1:61577", "127.0.0.1:61580"]);
    assert.equal(count("execFile"), 2);
    assert.ok(!calls.some((c) => !c.startsWith("execFile") && c.includes("Group Containers")), "the group container itself is never opened");
  });

  test("lsof finds nothing usable: not this kind", async () => {
    asMac();
    for (const out of [undefined, "", "p1\ncIPNExtension\nn/dev/null\n", "n/x.io.tailscale.ipn.macos/sameuserproof-61577\n", "n/x.io.tailscale.ipn.macos/sameuserproof-0-abc\n", "n/x.io.tailscale.ipn.macos/sameuserproof-61577-\n"]) {
      mac = out === undefined ? {} : { lsof: out };
      const err = await localApiEndpoint().catch((e: unknown) => e);
      assert.ok(err instanceof EndpointError && err.reason === "missing", JSON.stringify(out));
    }
  });
});

// ---- the key stays secret -------------------------------------------------------------------------

describe("the key", () => {
  test("never appears in a message or a log line, whatever fails", async () => {
    asMac();
    const secret = `key-${randomUUID()}`;
    const said: string[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => void said.push(a.map(String).join(" "));
    try {
      const app: AppFiles = { port: "61001", key: secret };
      const run = async (setup: () => void, ask: () => Promise<unknown>) => {
        byPort.clear();
        bySocket.clear();
        forgetLocalApiEndpoint();
        mac = { app: { ...app } };
        setup();
        said.push(await failure(ask()));
      };
      await run(() => serveTcp(61001, key()), () => localApiIdentity.status()); // refused
      await run(() => {}, () => localApiIdentity.status()); // not running
      await run(() => serveTcp(61001, secret, "slow"), () => localApiIdentity.status());
      await run(() => serveTcp(61001, secret, "error-answer"), () => localApiIdentity.status());
      await run(() => serveTcp(61001, secret, "not-json"), () => localApiIdentity.whois(B_ADDR));
      await run(() => serveTcp(61001, secret, "whois-fails"), () => localApiIdentity.whois(B_ADDR));
      await run(() => (mac.app!.keyError = "EACCES"), () => localApiIdentity.status());
      await run(
        () => {
          mac = { lsof: `n/x.io.tailscale.ipn.macos/sameuserproof-61577-${secret}\n` };
          serveTcp(61577, key());
        },
        () => localApiIdentity.status(),
      );
      byPort.clear();
      serveTcp(61001, secret, "whois-fails");
      mac = { app: { ...app } };
      assert.equal(await callerNode({ remoteAddress: "100.64.0.2", remotePort: 41641 } as unknown as Socket), null);
    } finally {
      console.warn = warn;
    }
    assert.deepEqual(said.slice(0, 8), [MAC.refused, MAC.notRunning, MAC.slow, "tailscaled status: 500 boom", "tailscaled whois: not JSON", "tailscaled whois: 500 whois broke", MAC.notAdmin, MAC.refused]);
    assert.equal(said.length, 9, "and callerNode's warning");
    assert.match(said[8]!, /^\[mesh\] whois 100\.64\.0\.2:41641 failed: tailscaled whois: 500 whois broke$/);
    const encoded = Buffer.from(`:${secret}`).toString("base64");
    for (const line of said) assert.ok(!line.includes(secret) && !line.includes(encoded), line);
  });
});

// ---- the caller check -----------------------------------------------------------------------------

describe("the caller check through the Mac app", () => {
  test("a listed peer is let in: callerNode names its node through the app's LocalAPI", async () => {
    asMac();
    const peers = [{ id: "b", nodeId: "nPeerB2CNTRL", name: "b.tail.example" }];
    mac = { app: { port: "61001", key: key() } };
    const api = serveTcp(61001, mac.app!.key);
    assert.equal(getIdentity(), localApiIdentity, "the real identity, not a stub");
    const node = await callerNode({ remoteAddress: "100.64.0.2", remotePort: 41641 } as unknown as Socket);
    assert.equal(node, "nPeerB2CNTRL");
    assert.equal(peers.find((p) => p.nodeId === node)?.id, "b");
    assert.equal(await callerNode({ remoteAddress: "::ffff:100.64.0.2", remotePort: 41641 } as unknown as Socket), "nPeerB2CNTRL", "an IPv4-mapped source too");
    assert.equal(await callerNode({ remoteAddress: "100.64.0.9", remotePort: 41641 } as unknown as Socket), null, "a device Tailscale doesn't name");
    assert.deepEqual(
      api.seen.map((s) => [s.url, s.authorization]),
      [
        ["/localapi/v0/whois?addr=100.64.0.2%3A41641", basic(mac.app!.key)],
        ["/localapi/v0/whois?addr=100.64.0.2%3A41641", basic(mac.app!.key)],
        ["/localapi/v0/whois?addr=100.64.0.9%3A41641", basic(mac.app!.key)],
      ],
    );
  });
});

// ---- only when asked ------------------------------------------------------------------------------

describe("with the mesh off", () => {
  test("nothing looks for Tailscale until Find Hosts or Add Peer asks, and they say why on a Mac", async () => {
    asMac();
    mac = { app: { port: "61001", key: key() } };
    serveTcp(61001, mac.app!.key);
    const { testApp } = await import("./app-test-fixtures");
    const app = await testApp();
    for (const [method, path, body] of [
      ["GET", "/api/mesh", undefined],
      ["GET", "/api/mesh/settings", undefined],
      ["PUT", "/api/mesh/settings", { hostLabel: "Host A" }],
      ["GET", "/api/peer/hello", undefined],
      ["GET", "/api/mesh/front-door", undefined],
    ] as const) {
      const res = await app.request(path, { method, ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
      await res.text();
    }
    assert.deepEqual([calls, connections], [[], []], "no file read, no lookup, no connection");
    // Find Hosts asks: the same spies see it.
    const found = await app.request("/api/mesh/candidates");
    assert.equal(found.status, 200);
    assert.deepEqual(((await found.json()) as MeshCandidate[]).map((c) => c.nodeId), ["nPeerB2CNTRL"]);
    assert.deepEqual(connections, ["127.0.0.1:61001"]);
    // Quit the app: Add Peer by name and Find Hosts say so; nothing is saved.
    byPort.clear();
    const put = await app.request("/api/mesh/peers", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ peers: [{ name: "b.tail.example" }] }) });
    assert.deepEqual([put.status, await put.json()], [400, { error: `can't resolve peer names: ${MAC.notRunning}` }]);
    mac = {};
    const none = await app.request("/api/mesh/candidates");
    assert.deepEqual([none.status, await none.json()], [502, { error: MAC.missing }]);
    const info = (await (await app.request("/api/mesh")).json()) as { enabled: boolean };
    assert.equal(info.enabled, false);
  });
});
