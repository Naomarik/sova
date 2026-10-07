// Run: node scripts/run-tests.mjs server/mesh/proxy-wire.integration.test.ts
// The wire through the /peer/<id>/ hop (§app.harness/wire, "Hops change nothing"): a browser that asks for
// wire 2 and one that doesn't both reach the peer through this host's proxy (proxyPeer, upgradePeerSocket,
// wired as server/mesh/index.ts wires them), and each gets exactly what the peer sent it. The peer is a
// stand-in on loopback that answers per wire as a Sova server does (server/wire-rows.ts wireOf on the
// query it received): the recorded faux streams' v1 control frames (golden/wire/expected/faux/*/frames.json)
// or their pinned wire-2 frames (golden/wire/v2/faux/*/frames.json), and the scenario's rows per wire. So a
// query the hop changed, dropped or re-encoded shows as the wrong wire or a different echoed URL, and a
// frame it touched as a byte difference. No credentials, no model, nothing outside the OS temp dir.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import { WebSocket, WebSocketServer } from "ws";
import type { TranscriptItem } from "../../shared/protocol";
import { GOLDEN_DIR } from "../harness/pi/golden/golden";
import { branchOf, parsePi } from "../harness/pi/reader";
import { rowsOf } from "../transcript";
import { rowsFor, wireOf } from "../wire-rows";
import type { PeerEntry } from "./peers";
import { clearPeerReach, peerSocketRoute, proxyPeer, proxyTail, upgradePeerSocket } from "./proxy";

const FAUX = join(GOLDEN_DIR, "fixtures/faux");
const WIRE = join(GOLDEN_DIR, "wire");
const scenarios = readdirSync(FAUX).sort();
const json = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const v1Frames = new Map(scenarios.map((s) => [s, json<string[]>(join(WIRE, "expected/faux", s, "frames.json"))]));
const v2Frames = new Map(scenarios.map((s) => [s, json<string[]>(join(WIRE, "v2/faux", s, "frames.json"))]));
const v2Rows = new Map(scenarios.map((s) => [s, json<TranscriptItem[]>(join(WIRE, "v2/faux", s, "rows.json"))]));
const v1Rows = new Map(scenarios.map((s) => [s, rowsOf(branchOf(parsePi(readFileSync(join(FAUX, s, "session.jsonl"), "utf8")).entries))]));

/** A session path as a browser would send it: slashes, a space and a plus, so a re-encoding shows. */
const pathOf = (s: string) => `/srv/sessions/--wire hop+1--/${s}.jsonl`;
const scenarioOf = (path: string | null) => /\/([^/]+)\.jsonl$/.exec(path ?? "")?.[1] ?? "";

// ---- the peer: a Sova server's wire choice on whatever query reaches it ---------------------------

let peer: Server;
let relay: Server;
let peerBase = "";
let relayBase = "";
let restricted: PeerEntry;
let open: PeerEntry;

before(async () => {
  peer = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const s = scenarioOf(url.searchParams.get("path"));
    const rows = v1Rows.get(s);
    res.writeHead(rows ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ url: req.url, items: rows ? rowsFor(rows, wireOf(url.searchParams)) : [] }));
  });
  const wss = new WebSocketServer({ noServer: true });
  peer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://x");
    const s = scenarioOf(url.searchParams.get("path"));
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.send(JSON.stringify({ type: "echo", url: req.url }));
      for (const frame of (wireOf(url.searchParams) === 2 ? v2Frames : v1Frames).get(s) ?? []) ws.send(frame);
      ws.send(JSON.stringify({ type: "done" }));
    });
  });
  await new Promise<void>((r) => peer.listen(0, "127.0.0.1", r));
  peerBase = `http://127.0.0.1:${(peer.address() as AddressInfo).port}`;
  open = { id: "b", nodeId: "nB", label: "b", dnsName: "b.invalid", url: peerBase };
  restricted = { ...open, id: "r", nodeId: "nR" };

  // This host's relay, wired as server/mesh/index.ts wires the main listener's /peer/<id>/ routes.
  const app = new Hono();
  const peerTail = (u: string) => new URL(u).pathname.replace(/^\/peer\/[^/]+/, "");
  app.all("/peer/:id/api/*", (c) => {
    const p = [open, restricted].find((x) => x.id === c.req.param("id"));
    const tail = proxyTail(peerTail(c.req.url));
    return p && tail ? proxyPeer(c, p, tail, p === restricted) : c.json({ error: "Not found" }, 404);
  });
  relay = createServer(getRequestListener(app.fetch));
  relay.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://x");
    const route = peerSocketRoute(url.pathname);
    if (!route) return void socket.destroy();
    const p = [open, restricted].find((x) => x.id === route[0]) ?? null;
    upgradePeerSocket(req, socket, head, p, route[1], url.search, p === restricted);
  });
  await new Promise<void>((r) => relay.listen(0, "127.0.0.1", r));
  relayBase = `127.0.0.1:${(relay.address() as AddressInfo).port}`;
});

after(() => {
  clearPeerReach();
  for (const s of [relay, peer]) {
    s.close();
    s.closeAllConnections();
  }
});

/** Every frame one socket gets, as the strings it carried, until the peer's "done". */
function frames(url: string): Promise<{ echo: string; got: string[]; binary: boolean }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const got: string[] = [];
    let binary = false;
    const timer = setTimeout(() => (ws.terminate(), reject(new Error(`no "done" within 5 s: ${url}`))), 5000);
    ws.on("message", (data, isBinary) => {
      binary ||= isBinary;
      const text = String(data);
      if (text === '{"type":"done"}') {
        clearTimeout(timer);
        ws.close();
        const [first, ...rest] = got;
        resolve({ echo: (JSON.parse(first!) as { url: string }).url, got: rest, binary });
      } else got.push(text);
    });
    ws.on("error", (err) => (clearTimeout(timer), reject(err)));
  });
}

/** Equal string lists, or a failure naming the first frame that differs (not the whole stream). */
function sameFrames(got: readonly string[], want: readonly string[], where: string): void {
  const i = got.findIndex((f, k) => f !== want[k]);
  if (i >= 0 || got.length !== want.length)
    assert.fail(`${where}: ${i >= 0 ? `frame ${i} differs: ${got[i]!.slice(0, 120)} vs ${String(want[i]).slice(0, 120)}` : `${got.length} frames, ${want.length} expected`}`);
}

/** Queries a browser sends, wire 2 asked for or not, in the orders and spellings it may use. */
const queries = (s: string): { search: string; wire: 1 | 2 }[] => {
  const p = encodeURIComponent(pathOf(s));
  return [
    { search: `?path=${p}`, wire: 1 },
    { search: `?path=${p}&wire=2`, wire: 2 },
    { search: `?wire=2&path=${p}&tail=1`, wire: 2 },
    { search: `?path=${p}&v=3&wire=2`, wire: 2 },
    { search: `?path=${p}&wire=1`, wire: 1 },
  ];
};

describe("/peer/<id>/ws/chat and /ws/watch: the query arrives verbatim, the frames byte for byte", () => {
  for (const s of scenarios)
    test(`faux/${s}: a v1 consumer and a wire-2 consumer, through an open and a restricted peer`, async () => {
      for (const route of ["/ws/chat", "/ws/watch"])
        for (const { search, wire } of queries(s))
          for (const p of [open, restricted]) {
            const where = `${p.id}${route}${search}`;
            const direct = await frames(`ws://${peerBase.slice("http://".length)}${route}${search}`);
            const hop = await frames(`ws://${relayBase}/peer/${p.id}${route}${search}`);
            assert.equal(hop.echo, `${route}${search}`, `${where}: the peer got the query as the browser sent it`);
            sameFrames(hop.got, direct.got, `${where}: the hop changed no frame`);
            sameFrames(hop.got, (wire === 2 ? v2Frames : v1Frames).get(s)!, `${where}: wire ${wire}'s frames`);
            assert.equal(hop.binary, false, `${where}: text frames stay text`);
            for (const f of hop.got) {
              const m = JSON.parse(f) as { type: string; v?: number };
              if (m.type === "event") assert.equal(m.v, wire === 2 ? 2 : undefined, `${where}: ${f.slice(0, 80)}`);
            }
          }
    });
});

describe("/peer/<id>/api/transcript: the query arrives verbatim, the rows as the peer sent them", () => {
  for (const s of scenarios)
    test(`faux/${s}: rows with meta without wire=2, with facts with it`, async () => {
      for (const { search, wire } of queries(s))
        for (const p of [open, restricted]) {
          const where = `${p.id} /api/transcript${search}`;
          const direct = await (await fetch(`${peerBase}/api/transcript${search}`)).text();
          const res = await fetch(`http://${relayBase}/peer/${p.id}/api/transcript${search}`);
          assert.equal(res.status, 200, where);
          const body = await res.text();
          assert.ok(body === direct, `${where}: the body byte for byte (${body.length} bytes, ${direct.length} sent)`);
          const got = JSON.parse(body) as { url: string; items: TranscriptItem[] };
          assert.equal(got.url, `/api/transcript${search}`, `${where}: the peer got the query as the browser sent it`);
          assert.deepEqual(got.items, wire === 2 ? v2Rows.get(s) : JSON.parse(JSON.stringify(v1Rows.get(s))), `${where}: wire ${wire}'s rows`);
          assert.ok(got.items.length > 0, `${where}: rows came`);
          for (const it of got.items) assert.equal(wire === 2 ? "meta" in it : "facts" in it, false, `${where}: row ${it.id}`);
        }
    });
});
