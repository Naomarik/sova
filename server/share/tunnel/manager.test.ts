import { dropScratchAgentDir, scratchAgentDir } from "../../testing/scratch-agent-dir";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import type { TunnelKey, TunnelMode } from "../../../shared/public-links";
import type { Driver, UnitSpec, UnitStatus } from "../../project-services/drivers";
import type { CloudflaredFound } from "./binary";
import { AUTO_RESTARTS_PER_HOUR, CHECK_WINDOW_MS, INGRESS_RECHECK_MS, ingressVerdict, RETRY_DELAYS_MS, TunnelManager, UNVERIFIED, type MetricsAnswer, type TunnelDeps } from "./manager";
import { writeTunnels, type TunnelRecord } from "./state";
import { envFileOf, exitFileOf, pidFileOf, tunnelsFile, tunnelUnitOf } from "./units";

after(dropScratchAgentDir);

const SHARE: TunnelKey = { kind: "share" };
const HASH = "abc123";
const UNIT = tunnelUnitOf(SHARE, HASH);
let dir = "";
let n = 0;
beforeEach(() => {
  dir = join(scratchAgentDir, "sova", `tunnels-${++n}`);
  mkdirSync(dir, { recursive: true });
});

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

/** A world of fakes: a driver that only records, a cloudflared per unit whose metrics the test sets,
    a manual clock and timers, and a watch the test fires. Every read of a tunnel is counted. */
function world(o: { found?: CloudflaredFound; wanted?: boolean; mode?: TunnelMode; account?: { token: string; publicUrl: string } | null; driver?: "systemd" | "detached" } = {}) {
  let clock = 1_794_000_000_000;
  const timers: { at: number; fn: () => void; dead: boolean }[] = [];
  const calls: string[] = [];
  const starts: UnitSpec[] = [];
  const stops: string[] = [];
  /** Per metrics port: what cloudflared answers, or nothing. */
  const tunnels = new Map<number, { connectorId: string; host: string; ready: number; ingress?: string | null } | null>();
  const unitState = new Map<string, UnitStatus["state"]>();
  let onFile: ((name: string) => void) | null = null;
  let watches = 0;
  let nextPort = 41000;
  let hostN = 0;
  const state = { wanted: o.wanted ?? true, mode: o.mode ?? "quick", account: o.account ?? null, verifyOk: true, quickAllowed: true, ingress: "http://127.0.0.1:4802" as string | null, logs: ["ERR something"] };
  const driver: Driver = {
    id: o.driver ?? "systemd",
    available: async () => ({ ok: true, detail: "" }),
    start: async (spec) => {
      calls.push(`start ${spec.unit}`);
      starts.push(spec);
      unitState.set(spec.unit, "active");
      const port = Number(spec.argv[spec.argv.indexOf("--metrics") + 1]!.split(":")[1]);
      tunnels.set(port, { connectorId: `c${starts.length}`, host: `h${++hostN}.trycloudflare.com`, ready: 200, ingress: state.ingress });
    },
    stop: async (unit) => {
      calls.push(`stop ${unit}`);
      stops.push(unit);
      unitState.set(unit, "inactive");
    },
    status: async (unit) => {
      calls.push(`status ${unit}`);
      return { state: unitState.get(unit) ?? "missing", pid: null };
    },
    signal: async () => {},
    owns: () => false,
    pids: () => [],
    logs: async () => state.logs.map((text) => ({ t: "", text })),
    runOnce: async () => ({ code: 0, timedOut: false, ms: 0 }),
    units: async () => {
      calls.push("units");
      return [UNIT];
    },
  };
  const deps: TunnelDeps = {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    setTimer: (fn, ms) => {
      const t = { at: clock + ms, fn, dead: false };
      timers.push(t);
      return { cancel: () => (t.dead = true) };
    },
    chooseDriver: async () => o.driver ?? "systemd",
    driver: () => driver,
    resolveCloudflared: async () => o.found ?? { ok: true, path: "/usr/bin/cloudflared", version: "2026.10.7", source: "path" },
    shareTarget: async (recorded) => recorded ?? 4802,
    shareWanted: () => state.wanted,
    quickAllowed: () => state.quickAllowed,
    previewWanted: () => state.wanted,
    shareMode: () => state.mode,
    account: () => state.account,
    metrics: async (port, path): Promise<MetricsAnswer> => {
      calls.push(`GET ${path}`);
      const t = tunnels.get(port);
      if (!t) return null;
      if (path === "/ready") return { status: t.ready, body: { status: t.ready, connectorId: t.connectorId } };
      if (path === "/config") return { status: 200, body: t.ingress === null ? { version: 0, config: {} } : { version: 1, config: { ingress: [{ service: t.ingress }, { service: "http_status:404" }] } } };
      return { status: 200, body: { hostname: t.host } };
    },
    freePort: async () => ++nextPort,
    verify: async () => (state.verifyOk ? { ok: true } : { ok: false, error: "Timed out" }),
    watch: (_d, cb) => {
      watches++;
      onFile = cb;
      return {
        close: () => {
          watches--;
          onFile = null;
        },
      };
    },
    unitEnv: () => ({ PATH: "/usr/bin" }),
    dir: () => dir,
    hash: () => HASH,
    log: () => {},
  };
  const m = new TunnelManager(deps);
  const metricsPortOf = (spec: UnitSpec) => Number(spec.argv[spec.argv.indexOf("--metrics") + 1]!.split(":")[1]);
  return {
    m,
    deps,
    state,
    calls,
    starts,
    stops,
    tunnels,
    unitState,
    watching: () => watches,
    advance: async (ms: number) => {
      clock += ms;
      for (const t of timers.filter((x) => !x.dead && x.at <= clock)) {
        t.dead = true;
        t.fn();
      }
      await flush();
    },
    now: () => clock,
    /** cloudflared connected: it writes its pidfile, the watch sees it. */
    connect: async () => {
      await flush();
      const unit = starts.at(-1)!.unit;
      writeFileSync(pidFileOf(unit, dir), "123\n");
      onFile?.(`${unit}.pid`);
      await flush();
    },
    /** The unit ended: its hook writes the end line, the watch sees it. */
    exit: async (line = "exit-code exited 1", unit = UNIT) => {
      unitState.set(unit, "failed");
      for (const s of starts) if (s.unit === unit) tunnels.set(metricsPortOf(s), null);
      writeFileSync(exitFileOf(unit, dir), `${line} ${Math.floor(clock / 1000)}\n`);
      onFile?.(`${unit}.exit`);
      await flush();
    },
    fire: (name: string) => onFile?.(name),
    metricsPortOf,
  };
}

async function up(w: ReturnType<typeof world>, key: TunnelKey = SHARE) {
  const p = w.m.ensure(key);
  await w.connect();
  return p;
}

test("a first share starts the tunnel lazily and answers its address; the record is written before the start", async () => {
  const w = world();
  assert.equal(w.watching(), 0, "nothing at idle");
  const p = w.m.ensure(SHARE, { by: "session:x" });
  await flush();
  assert.equal(w.starts.length, 1);
  const rec = JSON.parse(readFileSync(tunnelsFile(dir), "utf8")).tunnels.share as TunnelRecord;
  assert.equal(rec.unit, UNIT, "recorded before cloudflared connected");
  assert.equal(statSync(tunnelsFile(dir)).mode & 0o777, 0o600);
  assert.equal(w.watching(), 1);
  await w.connect();
  const s = await p;
  assert.equal(s.state, "up");
  assert.equal(s.origin, "https://h1.trycloudflare.com");
  assert.equal(s.epoch, w.now());
  const argv = w.starts[0]!.argv;
  assert.ok(argv.includes("--no-autoupdate") && argv.includes("http://127.0.0.1:4802"));
});

test("two shares at once start one tunnel", async () => {
  const w = world();
  const a = w.m.ensure(SHARE);
  const b = w.m.ensure(SHARE);
  await w.connect();
  assert.deepEqual([(await a).origin, (await b).origin], ["https://h1.trycloudflare.com", "https://h1.trycloudflare.com"]);
  assert.equal(w.starts.length, 1);
});

test("no polling: between two events inside the window no read of the tunnel happens; after the window or an event, exactly one", async () => {
  const w = world();
  await up(w);
  const reads = () => w.calls.filter((c) => c.startsWith("GET") || c.startsWith("status")).length;
  const base = reads();
  // Many demands inside the window, and time passing with no demand at all: no read.
  for (let i = 0; i < 10; i++) {
    await w.m.check(SHARE);
    await w.m.ensure(SHARE);
    await w.advance(CHECK_WINDOW_MS / 20);
  }
  await w.advance(10 * CHECK_WINDOW_MS - (CHECK_WINDOW_MS / 2));
  assert.equal(reads(), base, "a demand inside the window, and idle time, read nothing");
  // A demand past the window: one look (/ready + /quicktunnel).
  await w.m.check(SHARE);
  assert.equal(reads(), base + 2);
  await w.m.check(SHARE);
  assert.equal(reads(), base + 2);
  // An event marks it: the next demand looks again, even inside the window.
  w.fire(`${UNIT}.pid`);
  await w.m.check(SHARE);
  assert.equal(reads(), base + 4);
  // The rule can fail: a stand-in that checks on every demand would have read 20+ times.
});

test("an ended Free tunnel still wanted starts again from its exit event (new address, new epoch, the old one kept), at most 3 an hour", async () => {
  const w = world();
  const first = await up(w);
  const seen: string[] = [];
  w.m.onChanged((s) => seen.push(s.state));
  for (let i = 1; i <= AUTO_RESTARTS_PER_HOUR; i++) {
    await w.advance(1000);
    await w.exit();
    assert.equal(w.starts.length, i + 1, `restart ${i}`);
    await w.connect();
    const s = w.m.status(SHARE);
    assert.equal(s.state, "up");
    assert.equal(s.origin, `https://h${i + 1}.trycloudflare.com`);
    assert.equal(s.previous?.origin, `https://h${i}.trycloudflare.com`);
    assert.ok(s.epoch! > first.epoch!);
  }
  assert.ok(seen.includes("stopped") && seen.includes("starting") && seen.includes("up"), "every state change is told");
  await w.exit();
  assert.equal(w.starts.length, AUTO_RESTARTS_PER_HOUR + 1, "the budget is spent: no 4th restart from an event");
  assert.equal(w.m.status(SHARE).state, "failed");
  assert.equal(existsSync(tunnelsFile(dir)), false);
  assert.equal(w.watching(), 0, "no tunnel left: the watch is closed");
  // A demand still starts it (only events are budgeted).
  const again = w.m.ensure(SHARE);
  await w.connect();
  assert.equal((await again).state, "up");
  // An hour later the budget is back.
  await w.advance(3_600_000);
  await w.exit();
  assert.equal(w.starts.length, AUTO_RESTARTS_PER_HOUR + 3);
});

test("an ended tunnel no longer wanted stays stopped; its files go", async () => {
  const w = world();
  await up(w);
  w.state.wanted = false;
  await w.exit("success exited 0");
  assert.equal(w.starts.length, 1);
  assert.equal(w.m.status(SHARE).state, "stopped");
  for (const f of [pidFileOf(UNIT, dir), exitFileOf(UNIT, dir), tunnelsFile(dir)]) assert.equal(existsSync(f), false, f);
  assert.equal(w.watching(), 0);
});

test("no cloudflared: nothing starts, nothing downloads, the state says so", async () => {
  const w = world({ found: { ok: false, reason: "cloudflared isn't on this computer.", canDownload: true, install: "brew install cloudflared" } });
  const s = await w.m.ensure(SHARE);
  assert.equal(s.state, "needs-cloudflared");
  assert.equal(s.reason, "cloudflared isn't on this computer.");
  assert.equal(w.starts.length, 0);
  assert.equal(w.watching(), 0);
});

test("Account: no token starts nothing; a token reaches only the unit's env; systemd restarts it, Sova doesn't", async () => {
  const none = world({ mode: "account", account: null });
  const s = await none.m.ensure(SHARE);
  assert.deepEqual([s.state, s.reason, none.starts.length], ["failed", "no-token", 0]);
  const token = "eyJhIjoi" + "x".repeat(60);
  const w = world({ mode: "account", account: { token, publicUrl: "https://share.example.com" } });
  const a = await up(w);
  assert.deepEqual([a.state, a.origin, a.mode], ["up", "https://share.example.com", "account"]);
  assert.equal(w.starts[0]!.env.TUNNEL_TOKEN, token);
  assert.ok(!w.starts[0]!.argv.join(" ").includes(token));
  assert.ok(!readFileSync(tunnelsFile(dir), "utf8").includes(token));
  await w.exit();
  assert.equal(w.starts.length, 1, "systemd's Restart=always brings it back with the same address");
  assert.equal(w.m.status(SHARE).state, "degraded");
});

test("a start that fails is tried again at 30 s, 2 min and 10 min while wanted, then left to the next demand", async () => {
  const w = world();
  w.deps.driver = () => ({ ...(w.deps as any)._d, start: async () => { w.calls.push("start"); throw new Error("systemd-run failed"); }, stop: async () => {}, status: async () => ({ state: "missing", pid: null }), logs: async () => [] }) as unknown as Driver;
  const s = await w.m.ensure(SHARE);
  assert.equal(s.state, "failed");
  const startsAt = () => w.calls.filter((c) => c === "start").length;
  for (const [i, d] of RETRY_DELAYS_MS.entries()) {
    await w.advance(d - 1);
    assert.equal(startsAt(), i + 1, `not before ${d} ms`);
    await w.advance(1);
    assert.equal(startsAt(), i + 2);
  }
  await w.advance(24 * 3_600_000);
  assert.equal(startsAt(), RETRY_DELAYS_MS.length + 1, "then no more timers");
});

test("stop removes the unit and every file of it, and the watch", async () => {
  const w = world({ mode: "account", account: { token: "eyJ" + "y".repeat(50), publicUrl: "https://share.example.com" } });
  await up(w);
  mkdirSync(join(dir, "env"), { recursive: true });
  writeFileSync(envFileOf(UNIT, dir), "TUNNEL_TOKEN='x'\n");
  await w.m.stop(SHARE, "route changed");
  assert.deepEqual(w.stops, [UNIT]);
  for (const f of [pidFileOf(UNIT, dir), envFileOf(UNIT, dir), tunnelsFile(dir)]) assert.equal(existsSync(f), false, f);
  assert.equal(w.m.status(SHARE).state, "stopped");
  assert.equal(w.watching(), 0);
});

test("a stop during a start ends the start, kills the unit and leaves no retry", async () => {
  const w = world();
  const p = w.m.ensure(SHARE);
  await flush();
  await w.m.stop(SHARE, "route changed");
  assert.equal((await p).state, "stopped");
  assert.ok(w.stops.includes(UNIT));
  await w.advance(24 * 3_600_000);
  assert.equal(w.starts.length, 1);
});

/** A record as a Sova before a restart left it, its tunnel answering (or not) on its metrics port. */
function recorded(w: ReturnType<typeof world>, answer: { host: string; connectorId: string } | null, extra: Partial<TunnelRecord> = {}) {
  const rec: TunnelRecord = { mode: "quick", unit: UNIT, driver: "systemd", metricsPort: 45000, targetPort: 4999, origin: "https://kept.trycloudflare.com", connectorId: "c-kept", epoch: w.now() - 60_000, startedAt: w.now() - 60_000, startedBy: "operator", verifiedAt: w.now() - 59_000, autoRestarts: [], ...extra };
  writeTunnels({ share: rec }, tunnelsFile(dir));
  w.tunnels.set(45000, answer ? { ...answer, ready: 200 } : null);
  w.unitState.set(UNIT, answer ? "active" : "inactive");
  return rec;
}

test("adopt: no tunnels.json runs nothing at all", async () => {
  const w = world();
  await w.m.adopt();
  assert.deepEqual(w.calls, []);
  assert.equal(w.watching(), 0);
});

test("adopt: a tunnel that still answers with its host and connector is reattached, address and epoch unchanged, nothing started", async () => {
  const w = world();
  const rec = recorded(w, { host: "kept.trycloudflare.com", connectorId: "c-kept" });
  await w.m.adopt();
  const s = w.m.status(SHARE);
  assert.deepEqual([s.state, s.origin, s.epoch], ["up", rec.origin, rec.epoch]);
  assert.equal(w.starts.length, 0);
  assert.ok(!w.calls.some((c) => c.startsWith("status")), "no systemctl for a tunnel that answers");
  assert.equal(w.watching(), 1);
  assert.equal(w.m.recordedTargetPort(SHARE), 4999);
});

test("adopt: gone, replaced, or ended while Sova was down → the old address is kept as previous, a new one starts only if wanted, on the recorded port", async () => {
  const cases: [string, (w: ReturnType<typeof world>) => void][] = [
    ["no answer", (w) => recorded(w, null)],
    ["another tunnel answers", (w) => recorded(w, { host: "other.trycloudflare.com", connectorId: "c-other" })],
    [
      "an end line newer than the record",
      (w) => {
        recorded(w, { host: "kept.trycloudflare.com", connectorId: "c-kept" });
        writeFileSync(exitFileOf(UNIT, dir), `signal killed 9 ${Math.floor(w.now() / 1000)}\n`);
      },
    ],
  ];
  for (const wanted of [true, false])
    for (const [what, setup] of cases) {
      dir = join(scratchAgentDir, "sova", `tunnels-${++n}`);
      mkdirSync(dir, { recursive: true });
      const w = world({ wanted });
      setup(w);
      await w.m.adopt();
      if (what === "an end line newer than the record") assert.ok(!w.calls.includes("GET /ready"), `${what}: read from the file, no look`);
      if (what === "another tunnel answers") assert.ok(w.stops.includes(UNIT), `${what}: its unit is stopped`);
      assert.equal(w.m.status(SHARE).previous?.origin, "https://kept.trycloudflare.com", what);
      assert.equal(w.starts.length, wanted ? 1 : 0, `${what}, wanted ${wanted}`);
      if (wanted) {
        assert.ok(w.starts[0]!.argv.includes("http://127.0.0.1:4999"), "the recorded target port");
        await w.connect();
        assert.notEqual(w.m.status(SHARE).origin, "https://kept.trycloudflare.com");
      }
    }
});

test("adopt: a tunnels.json that can't be read stops this state root's units and is cleared", async () => {
  const w = world();
  writeFileSync(tunnelsFile(dir), "{not json");
  await w.m.adopt();
  assert.ok(w.calls.includes("units"));
  assert.ok(w.stops.length > 0 && w.stops.every((u) => u === UNIT));
  assert.equal(existsSync(tunnelsFile(dir)), false);
});

test("a tunnel up but cut off from Cloudflare reads degraded; a Free one down past two windows is started again on demand", async () => {
  const w = world();
  await up(w);
  const port = w.metricsPortOf(w.starts[0]!);
  w.tunnels.get(port)!.ready = 503;
  await w.advance(CHECK_WINDOW_MS);
  assert.equal((await w.m.check(SHARE)).state, "degraded");
  assert.equal(w.starts.length, 1);
  await w.advance(2 * CHECK_WINDOW_MS);
  await w.m.check(SHARE);
  await flush();
  assert.equal(w.starts.length, 2, "down too long: a new tunnel");
  assert.ok(w.stops.includes(UNIT));
});

test("an address that doesn't answer from outside is used, degraded, with the reason", async () => {
  const w = world();
  w.state.verifyOk = false;
  const s = await up(w);
  assert.equal(s.state, "up", "used, with the unverified warning: degraded is only for a tunnel that is down");
  assert.ok(s.reason?.startsWith(UNVERIFIED));
  assert.equal(s.origin, "https://h1.trycloudflare.com");
});

test("preview tunnels: one per app port, their hosts in memory for the edge", async () => {
  const w = world();
  const key: TunnelKey = { kind: "preview", port: 5173 };
  await up(w, key);
  assert.deepEqual([...w.m.previewHosts()], [["h1.trycloudflare.com", 5173]]);
  assert.equal(w.starts[0]!.unit, tunnelUnitOf(key, HASH));
  assert.equal(w.m.running().length, 1);
  await w.m.stop(key, "preview ended");
  assert.equal(w.m.previewHosts().size, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("no Free tunnel before Turn On, whoever asks (a share, a preview); Account needs none", async () => {
  for (const key of [SHARE, { kind: "preview" as const, port: 5173 }]) {
    const w = world();
    w.state.quickAllowed = false;
    const s = await w.m.ensure(key);
    assert.deepEqual([s.state, s.reason, w.starts.length, w.watching()], ["stopped", "turn-on", 0, 0]);
  }
  const a = world({ mode: "account", account: { token: "eyJ" + "z".repeat(40), publicUrl: "https://share.example.com" } });
  a.state.quickAllowed = false;
  assert.equal((await up(a)).state, "up");
});

test("every tunnel, a preview's included, forwards to the share listener's port, never the app's", async () => {
  const w = world();
  await up(w, { kind: "preview", port: 5173 });
  const argv = w.starts[0]!.argv;
  assert.equal(argv[argv.indexOf("--url") + 1], "http://127.0.0.1:4802");
  assert.ok(!argv.join(" ").includes("127.0.0.1:5173"));
});

test("a Free tunnel whose address isn't a trycloudflare.com host fails, and its unit is stopped", async () => {
  const w = world();
  const p = w.m.ensure(SHARE);
  await flush();
  w.tunnels.get(w.metricsPortOf(w.starts[0]!))!.host = "evil.example.com";
  await w.connect();
  assert.equal((await p).state, "failed");
  assert.ok(w.stops.includes(UNIT));
});

test("Account ingress: only the share listener's port or a fixed status; anything else is stopped at connect and at a check", async () => {
  const port = 4802;
  const ans = (ingress: unknown, status = 200): MetricsAnswer => ({ status, body: { version: 1, config: ingress === undefined ? {} : { ingress } } });
  const table: [MetricsAnswer, string][] = [
    [ans([{ service: "http://127.0.0.1:4802" }, { service: "http_status:404" }]), "ok"],
    [ans([{ service: "http://localhost:4802/" }]), "ok"],
    [ans(undefined), "unknown"],
    [ans([]), "unknown"],
    [{ status: 200, body: { version: 0 } }, "unknown"],
    [ans([{ service: "http://127.0.0.1:4800" }]), "bad"],
    [ans([{ service: "http://127.0.0.1:48020" }]), "bad"],
    [ans([{ service: "http://192.168.1.2:4802" }]), "bad"],
    [ans([{ service: "https://127.0.0.1:4802" }]), "bad"],
    [ans([{ service: "tcp://127.0.0.1:22" }]), "bad"],
    [ans([{ hostname: "x" }]), "bad"],
    [ans("all"), "bad"],
    [ans([], 404), "unknown"],
    [null, "unknown"],
  ];
  for (const [a, want] of table) assert.equal(ingressVerdict(a, port), want, JSON.stringify(a));
  const account = { token: "eyJ" + "q".repeat(40), publicUrl: "https://share.example.com" };
  const bad = world({ mode: "account", account });
  bad.state.ingress = "http://127.0.0.1:4800";
  const s = await up(bad);
  assert.equal(s.state, "failed");
  assert.match(s.reason ?? "", /point its public hostname at http:\/\/127\.0\.0\.1:4802/);
  assert.deepEqual(bad.stops, [UNIT]);
  // Good at connect, changed in the dashboard later: the next on-demand check stops it.
  const later = world({ mode: "account", account });
  assert.equal((await up(later)).state, "up");
  later.tunnels.get(later.metricsPortOf(later.starts[0]!))!.ingress = "http://127.0.0.1:4810";
  await later.advance(CHECK_WINDOW_MS);
  assert.equal((await later.m.check(SHARE)).state, "failed");
  assert.deepEqual(later.stops, [UNIT]);
});

test("a unit's log lines in a status never carry a token", async () => {
  const token = "eyJhIjoi" + "t".repeat(60);
  const w = world();
  w.state.logs = [`ERR TUNNEL_TOKEN=${token}`, `connecting with ${token}`];
  await up(w);
  w.state.wanted = false;
  await w.exit();
  const s = w.m.status(SHARE);
  assert.ok(s.detail?.length, "the log is shown");
  assert.ok(!JSON.stringify(s).includes(token.slice(0, 24)));
});

test("Account ingress fails closed: routes not pushed yet are looked at again 3, 10 and 30 s on (no demand needed), then it stops", async () => {
  const account = { token: "eyJ" + "r".repeat(40), publicUrl: "https://share.example.com" };
  const port = (w: ReturnType<typeof world>) => w.tunnels.get(w.metricsPortOf(w.starts[0]!))!;
  // Pushed later, pointing elsewhere: stopped at the next one-shot look.
  const late = world({ mode: "account", account });
  late.state.ingress = null;
  const s = await up(late);
  assert.equal(s.state, "degraded", "never up while its routes are unread");
  port(late).ingress = "http://127.0.0.1:4800";
  await late.advance(INGRESS_RECHECK_MS[0]);
  assert.equal(late.m.status(SHARE).state, "failed");
  assert.deepEqual(late.stops, [UNIT]);
  // Pushed later, right: up then.
  const good = world({ mode: "account", account });
  good.state.ingress = null;
  await up(good);
  await good.advance(INGRESS_RECHECK_MS[0]);
  port(good).ingress = "http://127.0.0.1:4802";
  await good.advance(INGRESS_RECHECK_MS[1] - INGRESS_RECHECK_MS[0]);
  assert.equal(good.m.status(SHARE).state, "up");
  assert.deepEqual(good.stops, []);
  // Never readable: failed once the last look is spent, and no timer after it.
  const never = world({ mode: "account", account });
  never.state.ingress = null;
  await up(never);
  await never.advance(INGRESS_RECHECK_MS[0]);
  await never.advance(INGRESS_RECHECK_MS[1] - INGRESS_RECHECK_MS[0]);
  await never.advance(INGRESS_RECHECK_MS[2] - INGRESS_RECHECK_MS[1] - 1);
  assert.equal(never.m.status(SHARE).state, "degraded");
  await never.advance(1);
  assert.equal(never.m.status(SHARE).state, "failed");
  assert.match(never.m.status(SHARE).reason ?? "", /couldn't read this tunnel's routes/);
  const reads = never.calls.length;
  await never.advance(24 * 3_600_000);
  assert.equal(never.calls.length, reads, "nothing after the last look");
});
