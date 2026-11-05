// Run: pnpm test:int -- server/mesh/localapi-endpoint.integration.test.ts
// How a host reaches its own Tailscale, over real connections: a stand-in for the Mac app's LocalAPI
// on 127.0.0.1 (Host local-tailscaled.sock, Basic auth ":"+key, 401 "auth required" without it) and a
// stand-in tailscaled on a unix socket, dialed by node:http itself (no in-process connection). The
// Mac's files and lsof are still faked (setLocalApiEndpointDeps). Every other case: the unit file.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, test } from "node:test";
import { forgetLocalApiEndpoint, setLocalApiEndpointDeps } from "./localapi-endpoint";
import { localApiIdentity } from "./localapi";
import { callerNode } from "./gate";

const MAC = {
  notRunning: "Tailscale isn't running on this Mac. Open the Tailscale app and connect.",
  slow: "Tailscale on this Mac didn't answer in time. Try again.",
};
const STATUS = `{"BackendState":"Running","Self":{"ID":"nSelfA1CNTRL","UserID":9007199254740993,"HostName":"a","DNSName":"a.tail.example.","OS":"macOS","Online":true,"TailscaleIPs":["100.64.0.1"]},"Peer":{},"User":{"9007199254740993":{"LoginName":"me@tail.example"}}}`;
const WHOIS = `{"Node":{"StableID":"nPeerB2CNTRL","Name":"b.tail.example.","Tags":[]},"UserProfile":{"LoginName":"me@tail.example"}}`;

const tmp = mkdtempSync(join(tmpdir(), "ts-"));
const basic = (key: string) => `Basic ${Buffer.from(`:${key}`).toString("base64")}`;
const key = () => `key-${randomUUID().slice(0, 8)}`;

interface Seen {
  host?: string;
  authorization?: string;
  url: string;
}

/** A stand-in LocalAPI: with a key, as the Mac app (401 without it); without, as tailscaled's socket. */
function localApiServer(opts: { key?: string; silent?: boolean; onRequest?: () => void } = {}): { server: Server; seen: Seen[] } {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    seen.push({ host: req.headers.host, authorization: req.headers.authorization, url: req.url ?? "" });
    opts.onRequest?.();
    if (opts.silent) return; // never answers
    const send = (status: number, body: string) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(body);
    };
    if (req.headers.host !== "local-tailscaled.sock") return send(400, "bad Host");
    if (opts.key !== undefined && req.headers.authorization !== basic(opts.key)) return send(401, "auth required\n");
    if (req.url === "/localapi/v0/status") return send(200, STATUS);
    if (req.url === "/localapi/v0/whois?addr=100.64.0.2%3A41641") return send(200, WHOIS);
    send(404, "no match for IP:port");
  });
  return { server, seen };
}

const servers: Server[] = [];
const listenTcp = async (s: Server): Promise<number> => {
  servers.push(s);
  await new Promise<void>((done) => s.listen(0, "127.0.0.1", done));
  return (s.address() as AddressInfo).port;
};
const listenUnix = async (s: Server, path: string): Promise<void> => {
  servers.push(s);
  await new Promise<void>((done) => s.listen(path, done));
};
/** A port nothing listens on: one the system just gave out and took back. */
const closedPort = async (): Promise<number> => {
  const s = createServer();
  await new Promise<void>((done) => s.listen(0, "127.0.0.1", done));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((done) => s.close(() => done()));
  return port;
};

// The tailscale.com app's files, as root leaves them, naming whatever `app` says now.
let app: { port: number; key: string } | null = null;
/** Homebrew's socket path, per test: absent until a test listens on it. */
let brewSocket = "";
const enoent = (p: string) => Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
const fakeInfo = (link: boolean) => ({ uid: 0, mode: link ? 0o120755 : 0o100640, isFile: () => !link, isSymbolicLink: () => link, isSocket: () => false });
const undo: Array<() => void> = [];

beforeEach(() => {
  app = null;
  brewSocket = join(tmp, `brew-${randomUUID().slice(0, 6)}.sock`);
  forgetLocalApiEndpoint();
  undo.push(
    setLocalApiEndpointDeps({
      platform: "darwin",
      env: {},
      uid: () => 501,
      lstat: async (p) => {
        if (app && p === "/Library/Tailscale/ipnport") return fakeInfo(true);
        if (p === brewSocket) return lstat(p); // a real socket, or ENOENT
        throw enoent(p);
      },
      readlink: async (p) => {
        if (app && p === "/Library/Tailscale/ipnport") return String(app.port);
        throw enoent(p);
      },
      open: async (p) => {
        if (!app || p !== `/Library/Tailscale/sameuserproof-${app.port}`) throw enoent(p);
        const text = `${app.key}\n`;
        return { stat: async () => fakeInfo(false), read: async () => text, close: async () => {} };
      },
      execFile: async () => {
        throw Object.assign(new Error("Command failed: lsof"), { code: 1 });
      },
      brewSocket,
    }),
  );
});
afterEach(async () => {
  while (undo.length) undo.pop()!();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((done) => s.close(() => done()))));
});
after(() => rmSync(tmp, { recursive: true, force: true }));

const failure = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected a failure");
};

describe("the Mac app's LocalAPI over 127.0.0.1", () => {
  test("its port with its key: status, whois and the caller check, and the stand-in refuses no key", async () => {
    const k = key();
    const { server, seen } = localApiServer({ key: k });
    app = { port: await listenTcp(server), key: k };
    assert.equal((await localApiIdentity.status()).peers.length, 0);
    assert.equal((await localApiIdentity.status()).self.login, "me@tail.example");
    assert.equal(await callerNode({ remoteAddress: "100.64.0.2", remotePort: 41641 } as unknown as Socket), "nPeerB2CNTRL");
    assert.equal(await localApiIdentity.whois("100.64.0.9:41641"), null);
    assert.deepEqual(
      seen.map((s) => [s.host, s.authorization]),
      Array.from({ length: 4 }, () => ["local-tailscaled.sock", basic(k)]),
    );
    // Without the key, the stand-in answers as the app does.
    const bare = await new Promise<number>((done, fail) =>
      request({ host: "127.0.0.1", port: app!.port, path: "/localapi/v0/status", headers: { Host: "local-tailscaled.sock" } }, (res) => {
        res.resume();
        done(res.statusCode ?? 0);
      })
        .on("error", fail)
        .end(),
    );
    assert.equal(bare, 401);
  });

  test("a key refused once: the app's new port and key, after one fresh look", async () => {
    const restarted = key();
    const fresh = localApiServer({ key: restarted });
    const freshPort = await listenTcp(fresh.server);
    const old = localApiServer({
      key: key(),
      onRequest: () => {
        app = { port: freshPort, key: restarted };
      },
    });
    app = { port: await listenTcp(old.server), key: key() };
    assert.equal((await localApiIdentity.status()).self.nodeId, "nSelfA1CNTRL");
    assert.deepEqual([old.seen.length, fresh.seen.length], [1, 1]);
  });

  test("the app's files naming a closed port: Homebrew's socket answers instead, else Tailscale isn't running", async () => {
    app = { port: await closedPort(), key: key() };
    assert.equal(await failure(localApiIdentity.status()), MAC.notRunning);
    const brew = localApiServer();
    await listenUnix(brew.server, brewSocket);
    assert.equal((await localApiIdentity.status()).self.nodeId, "nSelfA1CNTRL");
    assert.deepEqual(brew.seen.map((s) => [s.host, s.authorization]), [["local-tailscaled.sock", undefined]]);
  });

  test("no answer in time: Tailscale didn't answer in time", async () => {
    const k = key();
    const { server, seen } = localApiServer({ key: k, silent: true });
    app = { port: await listenTcp(server), key: k };
    assert.equal(await failure(localApiIdentity.status()), MAC.slow); // the request's own 2 s timeout
    assert.equal(seen.length, 1, "no retry after a timeout");
  });
});

describe("Linux, over a real socket", () => {
  test("SOVA_TAILSCALE_SOCKET: that socket; missing, tailscaled's own wording", async () => {
    const path = join(tmp, `ts-${randomUUID().slice(0, 6)}.sock`);
    undo.push(setLocalApiEndpointDeps({ platform: "linux", env: { SOVA_TAILSCALE_SOCKET: path } }));
    assert.match(await failure(localApiIdentity.status()), /^tailscaled unreachable: .*ENOENT/);
    const { server, seen } = localApiServer();
    await listenUnix(server, path);
    assert.equal((await localApiIdentity.status()).self.nodeId, "nSelfA1CNTRL");
    assert.deepEqual(seen.map((s) => [s.host, s.authorization]), [["local-tailscaled.sock", undefined]]);
  });
});
