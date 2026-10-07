// Run: node scripts/run-tests.mjs server/share-edge.test.ts. The public-links seams in process: the
// edge's names, links-events and setting-events, the security helpers, shareState and the allowlist,
// with a throwaway PI_CODING_AGENT_DIR; ~/.pi untouched. The edge's hooks on a real loopback port are
// share-edge.integration.test.ts.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";


const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-share-edge-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions"), { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

const edge = await import("./share/edge");
const listener = await import("./share/listener");
const events = await import("./share/links-events");
const settingEvents = await import("./share/setting-events");
const security = await import("./share/security");
const { validateSnapshot } = await import("./share/registry-validation");
const { callerNode, gatewayGate } = await import("./mesh/gate");
const { REFUSED_HEADER } = await import("./mesh/hello");
const contract = await import("../shared/public-links");

const TOKEN = "A".repeat(43);

/** Everything console.warn printed while `fn` ran (`fn` sees the lines so far). */
async function warnings(fn: (lines: string[]) => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    await fn(lines);
  } finally {
    console.warn = orig;
  }
  return lines.join("\n");
}

test("listener.ts still exports the edge's names, the same functions", () => {
  assert.equal(listener.createShareServer, edge.createShareServer);
  assert.equal(listener.shareMayReach, edge.shareMayReach);
  assert.equal(listener.clientAddress, edge.clientAddress);
  assert.equal(edge.clientAddress, security.clientAddress);
  assert.equal(listener.RateLimiter, edge.RateLimiter);
});
test("links-events: emitting returns at once; a mint's wait sees only its own changes: the first warning, timedOut, or failed", async () => {
  const mint = (kind: "h" | "i") => () => events.shareLinksChanged({ kind, cause: "mint" });
  const offA = events.onShareLinksChanged(() => {});
  const offB = events.onShareLinksChanged(async () => ({ warning: "not public yet" }));
  assert.equal(events.shareLinksChanged({ kind: "h", cause: "revoke" }), undefined, "outside a wait: fire and forget");
  assert.deepEqual((await events.awaitShareLinks(mint("h"))).outcome, { warning: "not public yet", timedOut: false, failed: false });
  offB();
  assert.deepEqual((await events.awaitShareLinks(() => 7)).result, 7);
  assert.deepEqual((await events.awaitShareLinks(() => 7)).outcome, { warning: null, timedOut: false, failed: false }, "nothing emitted, nothing to wait for");
  const offC = events.onShareLinksChanged(() => new Promise<void>(() => {}));
  // Ended by its 50 ms bound, not by the stuck listener: timedOut says which.
  assert.deepEqual((await events.awaitShareLinks(mint("i"), 50)).outcome, { warning: null, timedOut: true, failed: false });
  offC();
  assert.deepEqual((await events.awaitShareLinks(mint("h"), 200)).outcome, { warning: null, timedOut: false, failed: false }, "a stuck answer from an earlier mint is not this one's");
  const offD = events.onShareLinksChanged(() => {
    throw new Error("listener bug");
  });
  const log = await warnings(async () => {
    const { outcome } = await events.awaitShareLinks(async () => {
      await new Promise((r) => setTimeout(r, 5));
      events.shareLinksChanged({ kind: "h", cause: "mint" }); // after an await: still this mint's
    });
    assert.deepEqual(outcome, { warning: null, timedOut: false, failed: true }, "a throwing listener is failed, never confirmed");
  });
  assert.match(log, /listener failed/);
  offA();
  offD();
});

test("setting-events: a throwing or rejecting listener is logged, never unhandled, and the others still run", async () => {
  const file = { version: 1 as const, route: "off" as const };
  const got: string[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => void unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  const offs = [
    settingEvents.onPublicLinksChanged(async () => {
      throw new Error("rebind failed");
    }),
    settingEvents.onPublicLinksChanged(() => {
      throw new Error("sync failure");
    }),
    settingEvents.onPublicLinksChanged((f) => void got.push(f.route as string)),
  ];
  try {
    const log = await warnings(async (lines) => {
      settingEvents.publicLinksChanged(file);
      // Both failures logged (the rejecting one once its promise settles), then one more turn of the
      // loop for an unhandled rejection to surface if there were one.
      for (const end = Date.now() + 10_000; !(lines.some((l) => l.includes("rebind failed")) && lines.some((l) => l.includes("sync failure"))); await new Promise((r) => setTimeout(r, 5)))
        assert.ok(Date.now() < end, `both failures logged: ${lines.join(" | ")}`);
      await new Promise((r) => setImmediate(r));
    });
    assert.deepEqual(got, ["off"]);
    assert.match(log, /rebind failed/);
    assert.match(log, /sync failure/);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    for (const off of offs) off();
  }
});

test("the security helpers are real (their full tables: share-security.test.ts); clientAddress is unchanged", async () => {
  const req = (from: string, xff?: string) => ({ headers: xff ? { "x-forwarded-for": xff } : {}, socket: { remoteAddress: from } });
  for (const from of ["127.0.0.1", "100.101.1.2", "198.51.100.7"])
    assert.equal(security.trustedClient(req(from, "203.0.113.9"), { trust: "admitted", admitted: true }), "203.0.113.9", `admitted, from ${from}`);
  assert.equal(security.trustedClient(req("127.0.0.1", "198.51.100.1, 203.0.113.9"), { trust: "local-proxy" }), "203.0.113.9", "a loopback front: its last hop");
  assert.equal(security.trustedClient(req("100.101.1.2", "203.0.113.9"), { trust: "local-proxy" }), "100.101.1.2", "a tailnet source: its socket");
  assert.equal(security.trustedClient(req("127.0.0.1", "203.0.113.9"), { trust: "none" }), "127.0.0.1");
  assert.equal(edge.clientAddress(req("127.0.0.1", "203.0.113.9")), "203.0.113.9", "the listener's old rule is unchanged");
  assert.deepEqual(security.stripForwarded({ "x-forwarded-for": "1.2.3.4", accept: "*/*" }), { accept: "*/*" });
  assert.equal(validateSnapshot({ v: 1, seq: 1, links: [], assets: [], ingressPort: 4802 }, { now: Date.now() }).ok, true);
  assert.equal(await callerNode(new Socket()), null, "no remote address: nobody");
  assert.equal(await gatewayGate(() => ({ nodeId: "n1" }))(new Socket()), false);
});

test("shareState: off with its warning, the env pin configured but unverified (the setting's cases: public-links.test.ts)", () => {
  assert.deepEqual(listener.shareState({}), { state: "off", source: "setting", publicUrl: null, warning: contract.LINK_WARNINGS.off, warningCode: "off" });
  assert.deepEqual(listener.shareState({ SOVA_SHARE_PUBLIC_URL: "https://share.example.com/" }), {
    state: "configured",
    source: "env",
    publicUrl: "https://share.example.com",
    warning: contract.LINK_WARNINGS.unverified,
    warningCode: "unverified",
  });
});

test("every copy string is written: no placeholder left in the frozen contract", () => {
  const all = [...Object.values(contract.LINK_WARNINGS), ...Object.values(contract.FRONT_LABELS), ...Object.values(contract.OFFLINE_PAGE)];
  for (const text of all) assert.ok(!/^[A-Z-]+$/.test(text) && !/PENDING|TODO/.test(text), text);
});

test("session shares: /s/, /api/s/ and its image route are allowed, GET only; nothing else under /s", () => {
  const ok = [`/s/${TOKEN}`, `/api/s/${TOKEN}`, `/api/s/${TOKEN}/img/0`, `/api/s/${TOKEN}/img/7`, `/api/s/${TOKEN}/img/99999`];
  for (const p of ok) assert.equal(edge.shareMayReach("GET", p), true, p);
  const no: [string, string][] = [
    ["POST", `/api/s/${TOKEN}`],
    ["POST", `/api/s/${TOKEN}/message`],
    ["GET", `/api/s/${TOKEN}/message`],
    ["GET", `/api/s/${TOKEN}/img/01`],
    ["GET", `/api/s/${TOKEN}/img/-1`],
    ["GET", `/api/s/${TOKEN}/img/100000`],
    ["GET", `/api/s/${TOKEN}/img/`],
    ["GET", `/s/${TOKEN}/x`],
    ["GET", `/s/assets/index.js`],
    ["GET", `/api/s/${TOKEN}/img/1%2e`],
  ];
  for (const [m, p] of no) assert.equal(edge.shareMayReach(m, p), false, `${m} ${p}`);
});
