// Run: node scripts/run-tests.mjs server/mesh/lan-accept.integration.test.ts   (and on Node: --runtime node)
// An internet relay's accept process and Sova's handoff socket together (§mesh.lan/accept-process,
// §mesh.lan/handshake): loopback TCP stands in for the public side, a short unix path for the
// handoff. The dial-out host is the real RelayDialer with the internet mark. Each check waits for
// the verdict itself (a close, a hand-on, a log line), never a fixed time. The handoff directory's
// refusals and the default deadlines: lan-accept.test.ts.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { after, test } from "node:test";
import tls from "node:tls";
import { Acceptor } from "./lan-accept";
import { INTERNET_PROFILE } from "./lan-admission";
import { type LanIdentity, mintLanIdentity } from "./lan-cert";
import { type DialerStatus, RelayDialer, type RelayTarget } from "./lan-dialer";
import { HandoffServer } from "./lan-handoff";
import { headerLine } from "./lan-handoff-protocol";
import type { RelayPeer } from "./lan-relay";
import { connectReverse, type ReverseClient, serveReverse } from "./lan-reverse";
import { type Channel, dialOptions, livePeerPin } from "./lan-tls";

const sova = mintLanIdentity(); // the relay's own key: what the dial-out host pins
const outer = mintLanIdentity(); // the accept process's own
const mac = mintLanIdentity();
const stranger = mintLanIdentity();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const root = mkdtempSync(join(tmpdir(), "acc-"));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const freshDir = () => {
  const d = join(root, `d${n++}`);
  mkdirSync(d, { mode: 0o750 });
  chmodSync(d, 0o750);
  return d;
};

/** Poll with a generous hang guard: never a bound on how fast the accept process is. */
async function until(pred: () => boolean | Promise<boolean>, what: string, ms = 15_000): Promise<void> {
  const t0 = Date.now();
  while (!(await pred())) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

interface Rig {
  handoff: HandoffServer;
  acceptor: Acceptor;
  path: string;
  peers: RelayPeer[];
  got: Array<{ peer: RelayPeer; channel: Channel; sock: Duplex }>;
  clients: ReverseClient[];
  health: boolean[];
  logs: string[];
  stale: number;
  configure(): void;
  stop(): Promise<void>;
}

/** Sova's handoff socket (answering on `ask`, asking on `answer`), and an accept process dialing it. */
async function rig(opts: { build?: string; acceptorBuild?: string; silentMs?: number; beatMs?: number; headerMs?: number; innerMs?: number } = {}): Promise<Rig> {
  const dir = freshDir();
  const path = join(dir, "h.sock");
  const own = http.createServer((_req, res) => res.end("from the relay"));
  const r: Partial<Rig> & { got: Rig["got"]; clients: ReverseClient[]; health: boolean[]; logs: string[]; peers: RelayPeer[]; stale: number } = { got: [], clients: [], health: [], logs: [], peers: [{ id: "mac", label: "Mac", pin: mac.pin }], stale: 0 };
  const handoff = new HandoffServer({
    path,
    build: () => opts.build ?? "b1",
    identity: () => sova,
    acceptedByPin: (pin) => r.peers.find((p) => p.pin === pin) ?? null,
    onPeer: (sock, peer, channel) => {
      r.got.push({ peer, channel, sock });
      if (channel === "answer") void connectReverse(sock).then((c) => r.clients.push(c), () => {});
      else serveReverse(sock, (d) => own.emit("connection", d));
    },
    onHealth: (up) => r.health.push(up),
    ...(opts.silentMs ? { silentMs: opts.silentMs } : {}),
    ...(opts.headerMs ? { headerMs: opts.headerMs } : {}),
    ...(opts.innerMs ? { innerMs: opts.innerMs } : {}),
  });
  assert.equal(await handoff.start(), null);
  const acceptor = new Acceptor({
    handoffPath: path,
    identity: outer,
    build: opts.acceptorBuild ?? "b1",
    profile: { ...INTERNET_PROFILE, failuresToBan: 1000 },
    redialMs: 50,
    zeroPort: true,
    ...(opts.beatMs ? { beatMs: opts.beatMs } : {}),
    onStale: () => r.stale++,
    log: (l) => r.logs.push(l),
  });
  acceptor.start();
  r.handoff = handoff;
  r.acceptor = acceptor;
  r.path = path;
  r.configure = () => handoff.configure(r.peers.map((p) => p.pin), { host: "127.0.0.1", port: 0 });
  r.stop = async () => {
    await acceptor.stop();
    await handoff.stop();
  };
  return r as Rig;
}

const target = (port: number, over: Partial<RelayTarget> = {}): RelayTarget => ({ id: "vps", label: "VPS", host: "127.0.0.1", port, pin: sova.pin, internet: true, ...over });

function dialer(t: RelayTarget, channel: Channel, statuses: DialerStatus[], id: LanIdentity = mac) {
  const inner = http.createServer((_req, res) => res.end("from the dial-out host"));
  return new RelayDialer({
    identity: id, relay: t, channel, random: () => 0, connectTimeoutMs: 15_000,
    onStream: (d) => inner.emit("connection", d),
    onStatus: (s) => statuses.push(s),
  });
}

function fetchVia(agent: http.Agent): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "lan-peer", path: "/", agent }, (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => resolve(b));
    });
    req.on("error", reject);
    req.end();
  });
}

test("both channels come up through the accept process, end to end, and carry requests both ways", async () => {
  const r = await rig();
  await until(() => r.handoff.healthy(), "the control connection");
  assert.equal(r.handoff.state(), "running");
  r.configure();
  await until(() => r.acceptor.boundPort !== null, "the accept process listening");
  await until(() => r.handoff.listening().bound === r.acceptor.boundPort, "its beat");
  const port = r.acceptor.boundPort!;
  const sa: DialerStatus[] = [];
  const sq: DialerStatus[] = [];
  let askClient: ReverseClient | null = null;
  const ans = dialer(target(port), "answer", sa);
  const ask = new RelayDialer({ identity: mac, relay: target(port), channel: "ask", random: () => 0, onClient: (c) => (askClient = c), onStatus: (s) => sq.push(s) });
  ans.start();
  ask.start();
  await until(() => ans.status.state === "connected" && ask.status.state === "connected" && r.clients.length === 1 && askClient !== null, "both channels");
  assert.deepEqual(r.got.map((g) => [g.peer.id, g.channel]).sort(), [["mac", "answer"], ["mac", "ask"]]);
  assert.equal(await fetchVia(r.clients[0]!.agent), "from the dial-out host", "the relay asks on answer");
  assert.equal(await fetchVia(askClient!.agent), "from the relay", "the dial-out host asks on ask");
  assert.equal(r.acceptor.carriedCount, 2);
  ans.stop();
  ask.stop();
  await r.stop();
});

test("the accept process listens only while Sova names pins and an address; fail closed when control is lost", async () => {
  const r = await rig();
  await until(() => r.handoff.healthy(), "control");
  // The accept process takes Sova's configs one at a time, in order: once the last (pins and an
  // address) is listening, the two before it were handled, and the log says neither listened.
  r.handoff.configure([], { host: "127.0.0.1", port: 0 }); // no pins: no listener
  r.handoff.configure([mac.pin], null); // no address: no listener
  r.configure();
  await until(() => r.acceptor.boundPort !== null, "listening");
  assert.equal(r.logs.filter((l) => /^listening on port/.test(l)).length, 1, `only the last config listened: ${r.logs.join(" | ")}`);
  const port = r.acceptor.boundPort!;
  const s: DialerStatus[] = [];
  const d = dialer(target(port), "answer", s);
  d.start();
  await until(() => d.status.state === "connected", "connected");
  // Sova goes away (its handoff socket closes): the accept process stops listening at once and
  // ends what it carried; the dial-out host sees the connection end.
  await r.handoff.stop();
  await until(() => r.acceptor.boundPort === null, "the listener closed");
  await until(() => r.acceptor.carriedCount === 0, "carried connections ended");
  await until(() => d.status.state !== "connected", "the dialer saw it");
  const refused = await new Promise<string>((resolve) => {
    const c = net.connect(port, "127.0.0.1");
    c.once("connect", () => (c.destroy(), resolve("open")));
    c.once("error", (e) => resolve((e as NodeJS.ErrnoException).code ?? "error"));
  });
  assert.equal(refused, "ECONNREFUSED", "nothing listens on the public port without Sova");
  assert.ok(r.logs.some((l) => /control lost/.test(l)));
  d.stop();
  await r.acceptor.stop();
});

test("Sova losing the control connection ends everything handed over and reads as not running; a redial restores it", async () => {
  const r = await rig();
  await until(() => r.handoff.healthy(), "control");
  r.configure();
  await until(() => r.acceptor.boundPort !== null, "listening");
  const s: DialerStatus[] = [];
  const d = dialer(target(r.acceptor.boundPort!), "answer", s);
  d.start();
  await until(() => r.clients.length === 1, "connected");
  // The accept process restarts (its control closes from its side): Sova counts it lost.
  await r.acceptor.stop();
  await until(() => r.health.at(-1) === false, "Sova saw the loss");
  assert.equal(r.handoff.state(), "not running");
  await until(() => r.clients[0]!.destroyed, "the handed-over session ended");
  r.acceptor.start();
  await until(() => r.handoff.healthy(), "control again");
  await until(() => r.acceptor.boundPort !== null, "listening again (Sova re-sent its config)");
  d.stop();
  await r.stop();
});

test("an unpaired outer certificate never reaches Sova; the dialer reads it as the accept process refusing", async () => {
  const r = await rig();
  await until(() => r.handoff.healthy(), "control");
  r.configure();
  await until(() => r.acceptor.boundPort !== null, "listening");
  const s: DialerStatus[] = [];
  const d = dialer(target(r.acceptor.boundPort!), "answer", s, stranger);
  d.start();
  await until(() => s.some((x) => x.state === "waiting"), "a refusal");
  d.stop();
  const w = s.find((x): x is Extract<DialerStatus, { state: "waiting" }> => x.state === "waiting")!;
  assert.equal(w.reason, "accept process refused");
  assert.equal(r.got.length, 0, "Sova was handed nothing");
  assert.equal(r.handoff.mismatchAt, null);
  await r.stop();
});

test("a wrong relay pin (the inner one) is refused by the dial-out host before it writes", async () => {
  const r = await rig();
  await until(() => r.handoff.healthy(), "control");
  r.configure();
  await until(() => r.acceptor.boundPort !== null, "listening");
  const s: DialerStatus[] = [];
  const d = dialer(target(r.acceptor.boundPort!, { pin: stranger.pin }), "answer", s);
  d.start();
  await until(() => s.some((x) => x.state === "waiting"), "a refusal");
  d.stop();
  assert.equal(s.find((x): x is Extract<DialerStatus, { state: "waiting" }> => x.state === "waiting")!.reason, "relay's pin didn't match");
  assert.equal(r.got.length, 0);
  await r.stop();
});

/** Write a conn header straight to the handoff socket, as a (compromised) accept process could, then
    run the inner handshake as `id`. Resolves with how it ended. */
const forged: net.Socket[] = [];
function forge(r: Rig, header: { pin: string; channel: Channel }, id: LanIdentity | null, alpn: Channel = header.channel, max: "TLSv1.2" | "TLSv1.3" = "TLSv1.3"): Promise<string> {
  const before = r.got.length;
  return new Promise((resolve) => {
    const u = net.connect(r.path);
    forged.push(u);
    u.on("error", () => {});
    // Sova's verdict is the carrier closing (a nested client on Bun may not report it itself).
    u.once("close", () => resolve("closed"));
    u.once("connect", () => {
      u.write(headerLine({ kind: "conn", ...header }));
      const o = dialOptions(id ?? mac, "", 0, alpn);
      const { host: _h, port: _p, ...rest } = o;
      if (!id) {
        delete rest.key;
        delete rest.cert;
      }
      const t = tls.connect({ ...rest, minVersion: max, maxVersion: max, socket: u });
      t.on("error", (e) => resolve(`error ${(e as { code?: string }).code ?? ""}`));
      t.once("close", () => resolve("closed"));
      t.once("secureConnect", () => {
        // Even when this side thinks it finished, Sova decides: wait for its verdict, the carrier
        // closing (above) or the connection taken.
        livePeerPin(t);
        t.resume();
        void until(() => r.got.length > before || t.destroyed || u.destroyed, "Sova's verdict").then(() => resolve(r.got.length > before ? "taken" : "closed"));
      });
    });
  });
}

test("a forged handoff: the attested pin isn't the one the connection proves, so Sova refuses it and flags the accept process", async () => {
  const r = await rig();
  await until(() => r.handoff.healthy(), "control");
  r.configure();
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => void warnings.push(a.join(" "));
  try {
    // Vouches for the Mac, proves another key.
    assert.equal(await forge(r, { pin: mac.pin, channel: "answer" }, stranger), "closed");
    assert.ok(r.handoff.mismatchAt !== null, "flagged");
    assert.ok(warnings.some((w) => /vouched for a host the connection didn't prove/.test(w)), warnings.join("\n"));
    assert.ok(!warnings.some((w) => w.includes(mac.pin) || w.includes(stranger.pin)), "no pin in a log line");
    // Vouches for the right host on the wrong channel.
    assert.equal(await forge(r, { pin: mac.pin, channel: "ask" }, mac, "answer"), "closed");
    // No inner certificate at all.
    assert.equal(await forge(r, { pin: mac.pin, channel: "answer" }, null), "closed");
    // Inner TLS 1.2.
    assert.match(await forge(r, { pin: mac.pin, channel: "answer" }, mac, "answer", "TLSv1.2"), /closed|error/);
    assert.equal(r.got.length, 0, "nothing was taken");
    // The real thing still works on the same socket.
    assert.equal(await forge(r, { pin: mac.pin, channel: "ask" }, mac), "taken");
    await until(() => r.got.length === 1, "the honest one taken");
  } finally {
    console.warn = warn;
    for (const u of forged) u.destroy();
    for (const g of r.got) g.sock.destroy();
  }
  await r.stop();
});

test("a handed-over connection whose carrier breaks mid-handshake ends quietly: no uncaught error", async () => {
  const r = await rig();
  await until(() => r.handoff.healthy(), "control");
  r.configure();
  // A real ClientHello for the answer channel, captured off a stream nobody reads.
  const hello = await new Promise<Buffer>((resolve) => {
    const cap = new Duplex({ read() {}, write: (c: Buffer, _e, cb) => (resolve(c), cb()) });
    const { host: _h, port: _p, ...o } = dialOptions(mac, "", 0, "answer");
    tls.connect({ ...o, socket: cap }).on("error", () => {});
  });
  const caught: unknown[] = [];
  const onUncaught = (err: unknown) => caught.push(err);
  process.on("uncaughtException", onUncaught);
  try {
    // The header and the hello arrive together, and this side is gone before Sova answers: its
    // ServerHello meets a closed carrier (the accept process restarting mid-handshake does the same).
    const u = net.connect(r.path);
    u.on("error", () => {});
    const gone = new Promise((res) => u.once("close", res));
    u.once("connect", () => u.end(Buffer.concat([Buffer.from(headerLine({ kind: "conn", pin: mac.pin, channel: "answer" })), hello]), () => u.destroy()));
    await gone;
    await until(() => (r.handoff as unknown as { inner: Map<unknown, unknown> }).inner.size === 0, "Sova to drop the pending handshake");
    await new Promise((res) => setImmediate(res));
  } finally {
    process.off("uncaughtException", onUncaught);
  }
  assert.deepEqual(caught.map(String), []);
  assert.equal(r.got.length, 0);
  await r.stop();
});

test("a conn is taken only while control is healthy and for an accepted pin; at most 2 pending per pairing", async () => {
  // A pending inner handshake would only end at its deadline, here far past the hang guard: any
  // close seen below is a refusal, never that deadline.
  const r = await rig({ innerMs: 120_000 });
  const pending = () => (r.handoff as unknown as { inner: Map<unknown, unknown> }).inner.size;
  // Before any control: refused at once.
  const closesSoon = (pin: string) =>
    new Promise<boolean>((resolve) => {
      const u = net.connect(r.path);
      u.on("error", () => {});
      u.once("connect", () => u.write(headerLine({ kind: "conn", pin, channel: "answer" })));
      const t = setTimeout(() => (u.destroy(), resolve(false)), 15_000);
      u.once("close", () => (clearTimeout(t), resolve(true)));
    });
  await r.acceptor.stop();
  await until(() => !r.handoff.healthy(), "no control");
  assert.equal(await closesSoon(mac.pin), true, "no control: closed");
  r.acceptor.start();
  await until(() => r.handoff.healthy(), "control");
  r.configure();
  assert.equal(await closesSoon(stranger.pin), true, "an unpaired pin: closed");
  // Two pending inner handshakes for the Mac hold; a third is closed at once.
  const held: net.Socket[] = [];
  for (let i = 0; i < 2; i++) {
    const u = net.connect(r.path);
    u.on("error", () => {});
    await new Promise((res) => u.once("connect", res));
    u.write(headerLine({ kind: "conn", pin: mac.pin, channel: "answer" }));
    held.push(u);
  }
  await until(() => pending() === 2, "both held as pending handshakes");
  assert.equal(await closesSoon(mac.pin), true, "a third pending: closed");
  assert.equal(pending(), 2, "never taken as a third pending");
  assert.ok(held.every((u) => !u.destroyed), "the first two still wait for their handshake");
  for (const u of held) u.destroy();
  await r.stop();
});

test("headers: too long, too slow, or not one of the shapes closes the connection unread", async () => {
  // A short header deadline (the default, 2 s, is lan-accept.test.ts's).
  const r = await rig({ headerMs: 200 });
  const closed = (write: string | null) =>
    new Promise<boolean>((resolve) => {
      const u = net.connect(r.path);
      u.on("error", () => {});
      u.once("connect", () => write !== null && u.write(write));
      const t = setTimeout(() => (u.destroy(), resolve(false)), 15_000);
      u.once("close", () => (clearTimeout(t), resolve(true)));
    });
  assert.equal(await closed("x".repeat(300)), true, "no newline within 256 bytes");
  assert.equal(await closed(`${JSON.stringify({ v: 1, kind: "conn", pin: mac.pin, channel: "answer", from: "192.0.2.1" })}\n`), true, "an extra key");
  assert.equal(await closed("hello\n"), true, "not JSON");
  assert.equal(await closed(null), true, "nothing within the header deadline");
  await r.stop();
});

test("an accept process of another build is told to exit; Sova reads it as the wrong version", async () => {
  const r = await rig({ build: "new", acceptorBuild: "old" });
  await until(() => r.stale > 0, "the accept process told to exit");
  assert.equal(r.handoff.state(), "wrong version");
  assert.equal(r.handoff.healthy(), false);
  await r.stop();
});

test("a control connection that goes silent is dropped", async () => {
  const r = await rig({ silentMs: 300, beatMs: 60_000 });
  await until(() => r.handoff.healthy(), "control");
  await until(() => r.health.includes(false), "dropped for silence");
  await r.stop();
});

test("a stale handoff socket is replaced, and the new one is group read-write only", async () => {
  // The directory refusals, which bind nothing: lan-accept.test.ts.
  const opts = (path: string) => ({ path, build: () => "b1", identity: () => sova, acceptedByPin: () => null, onPeer: () => {} });
  const warn = console.warn;
  console.warn = () => {};
  try {
    // A socket left by an earlier run is replaced, and the new one is group read-write only.
    const ok = freshDir();
    const first = new HandoffServer(opts(join(ok, "h.sock")));
    assert.equal(await first.start(), null);
    const stale = new HandoffServer(opts(join(ok, "h.sock")));
    assert.equal(await stale.start(), null, "the stale socket replaced");
    const { statSync } = await import("node:fs");
    assert.equal(statSync(join(ok, "h.sock")).mode & 0o777, 0o660);
    await stale.stop();
    await first.stop();
  } finally {
    console.warn = warn;
  }
});
