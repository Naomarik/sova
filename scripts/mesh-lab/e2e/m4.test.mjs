// M4 — the Caddy front door in a user-set order: first healthy host serves; a dead first host
// fails over to the next; recovery fails back; order changes apply; a WebSocket held through the
// front door closes when its host dies and a reconnect lands on the next host. (The SPA's stale-tab
// check on reconnect is frontend's; this file proves the transport under it.)
//   scripts/mesh-lab/lab e2e m4        (restores order a,b,c… and every host at the end)
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { chaos, container, DOMAIN, exec, lab, laptopFetch, requireLab, SERVE_PORT, STATE, waitFor } from "./lib.mjs";

let cfg;
let order;
const upstreamOf = async () => {
  const r = await laptopFetch("frontdoor", "/api/health", { timeoutMs: 15000 });
  // Sova's generated Caddyfile names the upstream in X-Sova-Upstream; the lab's fallback template in X-Lab-Upstream
  return r.status === 200 ? (r.headers.get("x-sova-upstream") ?? r.headers.get("x-lab-upstream"))?.split(".")[0] : `status ${r.status}`;
};
const servedBy = (h, timeoutMs = 20000) => waitFor(async () => (await upstreamOf()) === h, { timeoutMs, intervalMs: 500, what: `front door served by ${h}` });

before(() => {
  cfg = requireLab();
  assert.ok(cfg.frontdoor, "lab up --frontdoor");
  assert.ok(cfg.hosts.length >= 3, "M4 needs 3 hosts");
  order = [...cfg.hosts];
  lab("frontdoor", "order", order.join(","));
});

after(async () => {
  lab("frontdoor", "order", cfg.hosts.join(","));
});

describe("the Caddyfile", () => {
  test("Caddy runs exactly what Sova generates for the order set on Sova (GET /api/mesh/front-door)", async () => {
    const reversed = [...order].reverse();
    lab("frontdoor", "order", reversed.join(","), "--sova");
    try {
      const gen = await (await laptopFetch(order[0], "/api/mesh/front-door")).json();
      assert.equal(typeof gen.caddyfile, "string");
      assert.equal(readFileSync(join(STATE, "caddy/Caddyfile"), "utf8"), gen.caddyfile, "the running file is Sova's, byte for byte");
      assert.match(gen.caddyfile, new RegExp(`reverse_proxy ${reversed.map((h) => `http://${h}\\.mesh\\.lab:8443`).join(" ")} \\{`), "in the order set on Sova");
      await servedBy(reversed[0]);
    } finally {
      lab("frontdoor", "order", order.join(","));
    }
    await servedBy(order[0]);
  });
});

describe("steady state", () => {
  test("with every host healthy, answers leave the first host only in short episodes Caddy's active check explains", async () => {
    // tailscale serve sometimes stalls new connections for seconds; when a stall spans the active
    // check's misses, Caddy benches the first host until it answers again. Accepted: episodes of
    // at most 5 s, each preceded by a logged failed active check of the first host. Not accepted: a
    // longer episode, or one with no failed check behind it (a passive bench on one stall, a flap).
    const secs = Number(process.env.M4_STEADY_SECONDS || 120);
    const maxEpisodeMs = 5000;
    await servedBy(order[0], 30000);
    const firstUp = `${order[0]}.${DOMAIN}:${SERVE_PORT}`;
    const maxFails = Number(/^\s*max_fails (\d+)/m.exec(readFileSync(join(STATE, "caddy/Caddyfile"), "utf8"))?.[1] ?? 1);
    const since = new Date().toISOString();
    const flips = [];
    let maxPassive = 0;
    let n = 0;
    let lastAdmin = 0;
    const end = Date.now() + secs * 1000;
    while (Date.now() < end) {
      let got;
      try {
        got = await upstreamOf();
      } catch (e) {
        got = `error ${e?.cause?.code || e?.name}`;
      }
      n++;
      if (got !== order[0]) flips.push({ at: Date.now(), who: got });
      if (Date.now() - lastAdmin >= 1000) {
        lastAdmin = Date.now();
        const up = JSON.parse(exec("caddy", ["wget", "-qO-", "http://127.0.0.1:2019/reverse_proxy/upstreams"]).out || "[]");
        maxPassive = Math.max(maxPassive, up.find((u) => u.address === firstUp)?.fails ?? 0);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    // episodes: consecutive answers not from the first host, gaps under 1 s
    const episodes = [];
    for (const f of flips) {
      const last = episodes.at(-1);
      if (last && f.at - last.to < 1000) (last.to = f.at), last.n++, last.who.add(f.who);
      else episodes.push({ from: f.at, to: f.at, n: 1, who: new Set([f.who]) });
    }
    const caddyLog = spawnSync("docker", ["logs", "--since", since, container("caddy")], { encoding: "utf8" });
    const entries = `${caddyLog.stdout}${caddyLog.stderr}`.split("\n").flatMap((l) => {
      try {
        const j = JSON.parse(l);
        return j.host === firstUp ? [{ ms: j.ts * 1000, msg: j.msg }] : [];
      } catch {
        return [];
      }
    });
    const failedChecks = entries.filter((e) => e.msg === "HTTP request failed" || e.msg === "status code out of tolerances");
    const benches = entries.filter((e) => e.msg === "host is up").length;
    const hhmmss = (t) => new Date(t).toISOString().slice(11, 23);
    // a failed check explains an episode when it lands in the 6 s before it (2 misses of a 2 s dial) or during it
    for (const e of episodes) e.checks = failedChecks.filter((c) => c.ms >= e.from - 6000 && c.ms <= e.to + 500).length;
    const fmt = (e) => `${hhmmss(e.from)}–${hhmmss(e.to)} ${[...e.who].join("/")} ×${e.n} (${e.to - e.from} ms, ${e.checks} failed check(s))`;
    console.log(`# steady state: ${n} requests over ${secs} s; ${flips.length} not from ${order[0]} in ${episodes.length} episode(s)${episodes.length ? `: ${episodes.map(fmt).join("; ")}` : ""}`);
    console.log(`# caddy on ${order[0]}: ${failedChecks.length} failed active checks, ${benches} active bench(es), passive fails max ${maxPassive}/${maxFails}`);
    assert.deepEqual(episodes.filter((e) => e.to - e.from > maxEpisodeMs).map(fmt), [], `episodes off ${order[0]} longer than ${maxEpisodeMs / 1000} s`);
    assert.deepEqual(episodes.filter((e) => e.checks === 0).map(fmt), [], `episodes off ${order[0]} with no failed active check behind them`);
  });
});

describe("ordered failover", () => {
  test("the first host in the order serves", async () => {
    await servedBy(order[0]);
    const r = await laptopFetch("frontdoor", "/");
    assert.equal(r.status, 200);
    assert.match(await r.text(), /<!doctype html>/i, "the SPA through the front door");
  });

  test("Sova down on the first host: the second serves within seconds; back up: fails back", async () => {
    const [first, second] = order;
    chaos.sovaStop(first);
    try {
      const t0 = Date.now();
      await servedBy(second);
      const ms = Date.now() - t0;
      console.log(`# failover ${first} -> ${second} (sova stopped): ${ms} ms`);
      assert.ok(ms <= 5000, `failover on a stopped Sova took ${ms} ms (bound 5 s)`);
    } finally {
      chaos.sovaStart(first);
    }
    const t1 = Date.now();
    await servedBy(first, 30000);
    console.log(`# failback -> ${first}: ${Date.now() - t1} ms`);
  });

  test("first host's container killed: the second serves; restarted: fails back", async () => {
    // A killed container blackholes its address. Sova's front door reuses upstream connections
    // (keepalive), so a request written into an idle pooled connection to the dead host waits for
    // the header timeout (35 s) and gets 504; new requests wait the 2 s dial and are retried on the
    // next host, and the health check then sends everything there. Checked: the failover time seen
    // by a client that gives up after 3 s (a browser retry), and that the requests fired every
    // 100 ms for 5 s after the kill (not waiting for each other) either answer within 3 s or are
    // among at most POOL hung ones, each a 504 within the header timeout, none longer.
    const [first, second] = order;
    const POOL = 4;
    const shots = [];
    const fire = () => {
      const t = Date.now();
      shots.push(
        laptopFetch("frontdoor", "/api/health", { timeoutMs: 45000 }).then(
          (r) => ({ ms: Date.now() - t, status: r.status }),
          (e) => ({ ms: Date.now() - t, status: 0, err: String(e?.cause?.code ?? e?.name ?? e) }),
        ),
      );
    };
    chaos.kill(first);
    try {
      const t0 = Date.now();
      fire();
      const timer = setInterval(fire, 100);
      setTimeout(() => clearInterval(timer), 5000);
      await waitFor(
        async () => {
          const r = await laptopFetch("frontdoor", "/api/health", { timeoutMs: 3000 });
          return r.status === 200 && r.headers.get("x-sova-upstream")?.split(".")[0] === second;
        },
        { timeoutMs: 30000, intervalMs: 500, what: `front door served by ${second}` },
      );
      const ms = Date.now() - t0;
      console.log(`# failover ${first} -> ${second} (container killed; 3 s client timeout): ${ms} ms`);
      await new Promise((r) => setTimeout(r, Math.max(0, 5200 - (Date.now() - t0))));
      const done = await Promise.all(shots);
      const hung = done.filter((r) => r.ms > 3000);
      console.log(`# requests fired over 5 s after the kill: ${done.length}; answered within 3 s: ${done.length - hung.length}; hung: ${hung.map((r) => `${r.status || r.err} after ${r.ms} ms`).join(", ") || "none"}`);
      assert.ok(ms <= 8000, `failover on a killed host took ${ms} ms (bound 8 s)`);
      assert.ok(hung.length <= POOL, `${hung.length} requests hung (at most ${POOL}, the pooled connections)`);
      for (const r of hung) assert.ok(r.status === 504 && r.ms <= 36000, `a hung request ended ${r.status || r.err} after ${r.ms} ms (want 504 within 35 s)`);
      for (const r of done.filter((r) => r.ms <= 3000)) assert.equal(r.status, 200, "a request answered within 3 s is a 200");
    } finally {
      chaos.start(first);
    }
    await servedBy(first, 120000);
  });

  test("first two down: the third serves", async () => {
    const [first, second, third] = order;
    chaos.sovaStop(first);
    chaos.sovaStop(second);
    try {
      await servedBy(third);
    } finally {
      chaos.sovaStart(first);
      chaos.sovaStart(second);
    }
    await servedBy(first, 30000);
  });

  test("a new order applies at once", async () => {
    const reversed = [...order].reverse();
    lab("frontdoor", "order", reversed.join(","));
    try {
      await servedBy(reversed[0]);
    } finally {
      lab("frontdoor", "order", order.join(","));
    }
    await servedBy(order[0]);
  });
});

describe("WebSockets through the front door", () => {
  test("a held WS closes when its host dies (never 4422), and a reconnect lands on the next host", async () => {
    const [first, second] = order;
    await servedBy(first);
    // watch a session the serving host has, so the socket stays open until the host dies
    const list = await (await laptopFetch("frontdoor", "/api/sessions")).json();
    const path = list[0]?.path;
    assert.ok(path, "the serving host has a session to watch");
    const events = [];
    const ws = new WebSocket(`ws://127.0.0.1:4890/ws/watch?path=${encodeURIComponent(path)}`);
    const opened = await new Promise((res) => {
      ws.onopen = () => res(true);
      ws.onclose = (e) => {
        events.push(e.code);
        res(false);
      };
      ws.onerror = () => {};
    });
    const closed = new Promise((res) => (ws.onclose = (e) => res(e.code)));
    if (!opened) return assert.fail(`watch did not open through the front door (close ${events[0]}); check /ws/watch params`);
    chaos.sovaStop(first);
    try {
      const code = await Promise.race([closed, new Promise((r) => setTimeout(() => r("still open after 20s"), 20000))]);
      assert.notEqual(code, 4422);
      assert.notEqual(code, "still open after 20s");
      await servedBy(second);
      const ws2 = new WebSocket(`ws://127.0.0.1:4890/ws/watch?path=${encodeURIComponent(path)}`);
      const r2 = await new Promise((res) => {
        ws2.onopen = () => res("open");
        ws2.onclose = (e) => res(`close ${e.code}`);
        ws2.onerror = () => {};
      });
      // the session lives on the first host: the second answers with its own verdict, not a hang
      assert.ok(r2 === "open" || /^close 4\d\d\d$/.test(r2), `reconnect reached ${second}: ${r2}`);
      try {
        ws2.close();
      } catch {}
    } finally {
      chaos.sovaStart(first);
    }
    await servedBy(first, 30000);
  });
});
