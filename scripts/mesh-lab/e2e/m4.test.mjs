// M4 — the Caddy front door in a user-set order: first healthy host serves; a dead first host
// fails over to the next; recovery fails back; order changes apply; a WebSocket held through the
// front door closes when its host dies and a reconnect lands on the next host. (The SPA's stale-tab
// check on reconnect is frontend's; this file proves the transport under it.)
//   scripts/mesh-lab/lab e2e m4        (restores order a,b,c… and every host at the end)
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chaos, lab, laptopFetch, requireLab, STATE, waitFor } from "./lib.mjs";

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
      console.log(`# failover ${first} -> ${second} (sova stopped): ${Date.now() - t0} ms`);
    } finally {
      chaos.sovaStart(first);
    }
    const t1 = Date.now();
    await servedBy(first, 30000);
    console.log(`# failback -> ${first}: ${Date.now() - t1} ms`);
  });

  test("first host's container killed: the second serves; restarted: fails back", async () => {
    const [first, second] = order;
    chaos.kill(first);
    try {
      const t0 = Date.now();
      await servedBy(second, 30000);
      console.log(`# failover ${first} -> ${second} (container killed): ${Date.now() - t0} ms`);
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
