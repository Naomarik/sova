// Run: pnpm test -- server/mesh/lan-internet.test.ts   (and on Node: pnpm run test:node -- server/mesh/lan-internet.test.ts)
// An internet relay end to end in one process (§mesh.lan/accept-process, §mesh.lan/pairing): this
// process's Sova server as the relay, with SOVA_RELAY_HANDOFF set; the accept process (lan-accept.ts)
// in-process too, on loopback standing in for the public address; a stand-in dial-out host with the
// internet mark. Sova never listens itself, nothing falls back to it, and grants hold both ways.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import tls from "node:tls";
import type { MeshSessionsView } from "../../shared/mesh-access";
import type { LanStatus } from "../../shared/mesh-lan";

const tmp = mkdtempSync(join(tmpdir(), "sova-lan-net-"));
const handoffDir = join(tmp, "relay");
mkdirSync(handoffDir, { mode: 0o750 });
chmodSync(handoffDir, 0o750);
const handoffPath = join(handoffDir, "h.sock");
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
process.env.PORT = "0";
process.env.SOVA_PEER_HOST = "127.0.0.1";
process.env.SOVA_PEER_PORT = "0";
process.env.SOVA_RELAY_HANDOFF = handoffPath;
mkdirSync(join(tmp, "agent", "sessions", "live"), { recursive: true });

const { setIdentity } = await import("./localapi");
setIdentity({
  status: async () => {
    throw new Error("no tailscale here");
  },
  whois: async () => null,
});

const { server } = await import("../index");
const { lanListenerPort, stopMesh } = await import("./index");
const { AUTH_COOKIE, sovaToken } = await import("../auth");
const { mintLanIdentity, parsePin } = await import("./lan-cert");
const { RelayDialer } = await import("./lan-dialer");
const { Acceptor } = await import("./lan-accept");
const { INTERNET_PROFILE } = await import("./lan-admission");
const { bootBuild } = await import("./build-id");
const { cleanBuild, headerLine } = await import("./lan-handoff-protocol");
const { dialOptions } = await import("./lan-tls");
const { agentFetch } = await import("./lan-fetch");
type ReverseClient = Awaited<ReturnType<typeof import("./lan-reverse").connectReverse>>;

const AUTH = { Cookie: `${AUTH_COOKIE}=${sovaToken()}` };
let base = "";
const api = async <T>(method: string, path: string, body?: unknown): Promise<[number, T]> => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...AUTH, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return [res.status, (await res.json()) as T];
};
const lan = async () => (await api<LanStatus>("GET", "/api/mesh/lan"))[1];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (what: string, ok: () => boolean | Promise<boolean>, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok()) return;
    await sleep(25);
  }
  assert.fail(`timed out waiting for ${what}`);
};
const portState = (port: number) =>
  new Promise<string>((resolve) => {
    const c = net.connect(port, "127.0.0.1");
    c.once("connect", () => (c.destroy(), resolve("open")));
    c.once("error", (e) => resolve((e as NodeJS.ErrnoException).code ?? "error"));
  });

const other = mintLanIdentity(); // the dial-out host
const stranger = mintLanIdentity();
const outerKey = mintLanIdentity(); // the accept process's own
const otherServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", "http://x");
  res.writeHead(200, { "content-type": "application/json" });
  if (url.pathname === "/api/peer/hello") return res.end(JSON.stringify({ mesh: 1, id: "other", label: "Other", hostname: "other", version: "0", protocol: "x", pi: "x", now: Date.now() }));
  if (url.pathname === "/api/sessions") return res.end(JSON.stringify([{ id: "far-1", path: "/far/one.jsonl" }]));
  res.end("{}");
});

let acceptor: InstanceType<typeof Acceptor>;
let relayPin = "";
let answer: InstanceType<typeof RelayDialer> | null = null;
let ask: InstanceType<typeof RelayDialer> | null = null;
let askClient: ReverseClient | null = null;
const acceptorLog: string[] = [];

before(async () => {
  await new Promise<void>((r) => (server.listening ? r() : server.once("listening", r)));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  acceptor = new Acceptor({
    handoffPath,
    identity: outerKey,
    build: cleanBuild(bootBuild()?.commit),
    profile: { ...INTERNET_PROFILE, failuresToBan: 1000 },
    redialMs: 50,
    zeroPort: true,
    log: (l) => acceptorLog.push(l),
  });
});

after(async () => {
  answer?.stop();
  ask?.stop();
  await acceptor.stop();
  stopMesh();
  server.close();
  server.closeAllConnections();
  otherServer.close();
  rmSync(tmp, { recursive: true, force: true });
});

const both = async (state: string) => {
  const p = (await lan()).pairings.find((x) => x.id === "laptop");
  return p?.channels.answer.state === state && p.channels.ask.state === state;
};

function dialers(port: number) {
  const target = { id: "relay", label: "Relay", host: "127.0.0.1", port, pin: relayPin, internet: true };
  answer = new RelayDialer({ identity: other, relay: target, channel: "answer", random: () => 0, onStream: (d) => otherServer.emit("connection", d) });
  ask = new RelayDialer({ identity: other, relay: target, channel: "ask", random: () => 0, onClient: (c) => (askClient = c) });
  answer.start();
  ask.start();
}

describe("this host as an internet relay", () => {
  test("Sova's own listener can't take a public address: lan.ts never asks for the internet scope", () => {
    const src = readFileSync(new URL("./lan.ts", import.meta.url), "utf8");
    assert.doesNotMatch(src, /scope\s*:/, "only relay-accept/main.ts (through lan-accept.ts) passes it");
    assert.match(readFileSync(new URL("./lan-accept.ts", import.meta.url), "utf8"), /scope: "internet"/);
  });

  test("an internet relay can't be saved while the accept process isn't running", async () => {
    const [, key] = await api<LanStatus>("POST", "/api/mesh/lan/key");
    relayPin = parsePin(key.fingerprint)!;
    assert.equal(key.acceptor.state, "not running", "configured, but the mesh is off: nothing listens yet");
    // A pairing turns the mesh on, and with it the handoff socket.
    const [s, r] = await api<LanStatus>("POST", "/api/mesh/lan/pairings", { id: "laptop", label: "Laptop", role: "accept", pin: other.pin });
    assert.equal(s, 200, JSON.stringify(r));
    await until("the handoff socket", () => existsSync(handoffPath));
    assert.equal(statSync(handoffPath).mode & 0o777, 0o660, "group read-write, nothing for others");
    const [s409, r409] = await api<{ error: string }>("PUT", "/api/mesh/lan/relay", { relay: { host: "127.0.0.1", port: 0, exposure: "internet" } });
    assert.equal(s409, 409);
    assert.equal(r409.error, "the accept process isn't running (SUDO.md §5)");
    assert.equal((await lan()).relay, undefined, "nothing saved");
  });

  test("with the accept process running it saves, and the accept process listens: Sova never does", async () => {
    acceptor.start();
    await until("the accept process running", async () => (await lan()).acceptor.state === "running");
    const [s, r] = await api<LanStatus>("PUT", "/api/mesh/lan/relay", { relay: { host: "127.0.0.1", port: 0, exposure: "internet" } });
    assert.equal(s, 200, JSON.stringify(r));
    assert.equal(r.relay?.exposure, "internet");
    await until("listening", async () => (await lan()).relay?.listening === true);
    const st = await lan();
    assert.equal(st.relay?.boundPort, acceptor.boundPort, "the port is the accept process's");
    assert.ok(st.relay?.counts, "its counts arrive in its beat");
    assert.equal(lanListenerPort(), null, "Sova runs no listener of its own for an internet relay");
    assert.ok(acceptorLog.some((l) => /^listening on port \d+ for 1 pairing$/.test(l)), acceptorLog.join("\n"));
    assert.ok(!acceptorLog.some((l) => l.includes("127.0.0.1") || l.includes(other.pin)), "the accept process logs no address or pin");
  });

  test("the dial-out host connects on both channels through the accept process, and grants hold both ways", async () => {
    dialers(acceptor.boundPort!);
    await until("both channels", () => both("connected"));
    // The relay asks on answer: the dial-out host answers (its own grant to the relay is its business).
    const [, sessions] = await api<MeshSessionsView>("GET", "/api/mesh/sessions");
    assert.equal(sessions.peers.find((p) => p.id === "laptop")?.state, "up");
    // The dial-out host asks on ask: this host's grant (presence) decides.
    const hello = await agentFetch(askClient!.agent, "/api/peer/hello");
    assert.equal(hello.status, 200);
    await hello.body?.cancel();
    const denied = await agentFetch(askClient!.agent, "/api/sessions");
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get("x-sova-mesh"), "denied");
    await denied.body?.cancel();
    await api("PUT", "/api/mesh/access", { peer: "laptop", grant: { preset: "sessions" } });
    const allowed = await agentFetch(askClient!.agent, "/api/sessions");
    assert.equal(allowed.status, 200);
    await allowed.body?.cancel();
    await api("PUT", "/api/mesh/access", { peer: "laptop", grant: { preset: "presence" } });
  });

  test("a forged handoff (the accept process vouching for the pairing, another key inside) is refused and shown", async () => {
    const warned: string[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => void warned.push(a.join(" "));
    try {
      const ended = await new Promise<string>((resolve) => {
        const u = net.connect(handoffPath);
        u.on("error", () => {});
        u.once("close", () => resolve("closed"));
        u.once("connect", () => {
          u.write(headerLine({ kind: "conn", pin: other.pin, channel: "ask" }));
          const { host: _h, port: _p, ...o } = dialOptions(stranger, "", 0, "ask");
          tls.connect({ ...o, socket: u }).on("error", () => {});
        });
        setTimeout(() => (u.destroy(), resolve("still open")), 3000);
      });
      assert.equal(ended, "closed");
    } finally {
      console.warn = warn;
    }
    assert.ok(warned.some((w) => /vouched for a host the connection didn't prove/.test(w)), warned.join("\n"));
    assert.ok((await lan()).acceptor.mismatchAt, "the Mesh page shows it");
    assert.ok(await both("connected"), "the real pairing is untouched");
  });

  test("losing the accept process ends both channels, the relay reads not listening, and nothing falls back to Sova", async () => {
    const port = acceptor.boundPort!;
    const client = askClient!;
    await acceptor.stop();
    await Promise.race([client.closed, sleep(2000).then(() => assert.fail("the ask channel is still open"))]);
    await until("both channels down", () => both("not connected"), 2000);
    const st = await lan();
    assert.equal(st.acceptor.state, "not running");
    assert.equal(st.relay?.listening, false);
    assert.equal(st.relay?.exposure, "internet", "the setting stays: a crash never turns the mesh off");
    assert.equal(await portState(port), "ECONNREFUSED", "nothing listens on the port");
    assert.equal(lanListenerPort(), null, "and Sova never falls back to one");
    // It comes back by itself.
    acceptor.start();
    await until("running again", async () => (await lan()).acceptor.state === "running");
    await until("listening again", async () => (await lan()).relay?.listening === true);
    answer?.stop();
    ask?.stop();
    dialers(acceptor.boundPort!);
    await until("both channels again", () => both("connected"), 10_000);
  });

  test("switching the relay to LAN ends every internet connection; Stop Relaying stops the accept process listening", async () => {
    const client = askClient!;
    const [s, r] = await api<LanStatus>("PUT", "/api/mesh/lan/relay", { relay: { host: "127.0.0.1", port: 0 } });
    assert.equal(s, 200, JSON.stringify(r));
    await Promise.race([client.closed, sleep(2000).then(() => assert.fail("still open after switching"))]);
    await until("the accept process stopped listening", () => acceptor.boundPort === null);
    await until("Sova's own LAN listener", async () => (await lan()).relay?.listening === true);
    assert.equal((await lan()).relay?.exposure, "lan");
    assert.equal(lanListenerPort(), (await lan()).relay?.boundPort, "a LAN relay is Sova's own listener");
    const [s2] = await api("PUT", "/api/mesh/lan/relay", { relay: null });
    assert.equal(s2, 200);
    assert.equal(acceptor.boundPort, null);
    answer?.stop();
    ask?.stop();
  });

  test("a dial pairing may name a public relay only with the internet mark", async () => {
    const [bad, why] = await api<{ error: string }>("POST", "/api/mesh/lan/pairings", { id: "vps", role: "dial", pin: stranger.pin, host: "203.0.113.10", port: 4803 });
    assert.equal(bad, 400);
    assert.match(why.error, /public address/);
    const [no, r] = await api<{ error: string }>("POST", "/api/mesh/lan/pairings", { id: "vps", role: "accept", pin: stranger.pin, internet: true });
    assert.equal(no, 400, JSON.stringify(r));
    const [ok, st] = await api<LanStatus>("POST", "/api/mesh/lan/pairings", { id: "vps", role: "dial", pin: stranger.pin, host: "203.0.113.10", port: 4803, internet: true });
    assert.equal(ok, 200, JSON.stringify(st));
    assert.equal(st.pairings.find((p) => p.id === "vps")?.internet, true);
    const [gone] = await api("DELETE", "/api/mesh/lan/pairings/vps");
    assert.equal(gone, 200);
  });
});
