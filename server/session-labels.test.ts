// Labels on a chat (server/session-labels.ts, server/session-labels-routes.ts): the store's rules, the
// declaration a request makes (`labels=<extId>:<key>,…`), the overlay and its inert path, and the
// write route's doors. Uses a throwaway PI_CODING_AGENT_DIR; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { Hono } from "hono";
import type { SessionSummary } from "../shared/protocol";

const agentDir = mkdtempSync(join(tmpdir(), "sova-session-labels-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths

const L = await import("./session-labels");
const { registerLabelRoutes } = await import("./session-labels-routes");
const { initAuthToken, setExtensionKeyCheck, sovaToken, TOKEN_HEADER } = await import("./auth");

after(() => rmSync(agentDir, { recursive: true, force: true }));

const storeFile = join(agentDir, "sova", "session-labels.json");
const clear = () => {
  rmSync(storeFile, { force: true });
  L.resetLabelsCache();
};
beforeEach(clear);

const row = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary =>
  ({ id, path: `/s/${id}.jsonl`, cwd: "/w", title: id, createdAt: "2026-01-01T00:00:00Z", lastActiveAt: "2026-01-01T00:00:00Z", live: null, origin: "web", archived: false, busy: false, ...extra }) as SessionSummary;

/** An array whose element reads are counted: "no per-row work" is zero reads. */
function counted(rows: SessionSummary[]): { rows: SessionSummary[]; reads: () => number } {
  let n = 0;
  const p = new Proxy(rows, {
    get(t, k, r) {
      if (typeof k === "string" && /^\d+$/.test(k)) n++;
      return Reflect.get(t, k, r);
    },
  });
  return { rows: p, reads: () => n };
}

describe("the declaration (labels=<extId>:<key>,…)", () => {
  test("names pairs; one filter, one canonical key whatever the order or repeats", () => {
    const a = L.parseLabelPairs("team-bar:owner,b.x:where");
    const b = L.parseLabelPairs("b.x:where,team-bar:owner,team-bar:owner");
    assert.ok(a && b);
    assert.equal(a.key, b.key);
    assert.deepEqual([...a.byExt.get("team-bar")!], ["owner"]);
  });
  test("absent, empty or malformed is no declaration at all", () => {
    const tooMany = Array.from({ length: L.LABEL_PAIRS_MAX + 1 }, (_, i) => `e:k${i}`).join(",");
    for (const raw of [undefined, null, "", "1", "team-bar", ":owner", "team-bar:", "team-bar:Owner", "a:b:c", "team-bar:owner,", "x y:owner", "..:k", tooMany])
      assert.equal(L.parseLabelPairs(raw), null, String(raw));
    assert.ok(L.parseLabelPairs(Array.from({ length: L.LABEL_PAIRS_MAX }, (_, i) => `e:k${i}`).join(",")));
  });
  test("the union of filters", () => {
    const u = L.unionPairs([L.parseLabelPairs("a:x")!, L.parseLabelPairs("b:y,a:x")!]);
    assert.equal(u?.key, "a:x,b:y");
    assert.equal(L.unionPairs([]), null);
  });
});

describe("the store", () => {
  test("a merge per extension; null deletes; nothing written for no change; a sidecar only", () => {
    assert.equal(existsSync(storeFile), false);
    const r1 = L.setLabels("s1", "/s/s1.jsonl", "alpha", { owner: "kim", where: " server " });
    assert.deepEqual(r1, { labels: { owner: "kim", where: "server" }, changed: true });
    assert.deepEqual(L.setLabels("s1", "/s/s1.jsonl", "beta", { owner: "lee" }), { labels: { owner: "lee" }, changed: true });
    assert.deepEqual(L.setLabels("s1", "/s/s1.jsonl", "alpha", { where: null }), { labels: { owner: "kim" }, changed: true });
    const before = readFileSync(storeFile, "utf8");
    assert.deepEqual(L.setLabels("s1", "/s/s1.jsonl", "alpha", { owner: "kim", gone: null }), { labels: { owner: "kim" }, changed: false });
    assert.equal(readFileSync(storeFile, "utf8"), before);
    assert.deepEqual(L.labelsOf("s1"), { alpha: { owner: "kim" }, beta: { owner: "lee" } });
    L.setLabels("s1", "/s/s1.jsonl", "alpha", { owner: null });
    L.setLabels("s1", "/s/s1.jsonl", "beta", { owner: null });
    assert.equal(L.labelsOf("s1"), undefined);
    assert.deepEqual(JSON.parse(readFileSync(storeFile, "utf8")), { version: 1, sessions: {} });
    assert.deepEqual(L.allLabels(), {});
  });
  test("at most LABEL_KEYS_MAX keys per extension per chat: the write that passes it writes nothing", () => {
    const eight = Object.fromEntries(Array.from({ length: L.LABEL_KEYS_MAX }, (_, i) => [`k${i}`, "v"]));
    assert.equal(typeof L.setLabels("s1", "/p", "alpha", eight), "object");
    assert.match(L.setLabels("s1", "/p", "alpha", { more: "v" }) as string, /at most 8/);
    assert.equal(Object.keys(L.labelsOf("s1")!.alpha!).length, L.LABEL_KEYS_MAX);
  });
  test("keys and values are checked; a hand-edited file loses only what is bad", () => {
    assert.equal(typeof L.cleanLabelChanges({ Owner: "x" }), "string");
    assert.equal(typeof L.cleanLabelChanges({ owner: "x".repeat(L.LABEL_VALUE_MAX + 1) }), "string");
    assert.equal(typeof L.cleanLabelChanges({ owner: "a\nb" }), "string");
    assert.equal(typeof L.cleanLabelChanges({ owner: 3 }), "string");
    assert.equal(typeof L.cleanLabelChanges(["x"]), "string");
    assert.deepEqual({ ...(L.cleanLabelChanges({ owner: "kim", where: null }) as object) }, { owner: "kim", where: null });
    writeFileSync(storeFile, JSON.stringify({ version: 1, sessions: { s1: { alpha: { owner: "kim", BAD: "x", n: 3 }, "bad id!": { k: "v" } }, s2: "nope" } }));
    L.resetLabelsCache();
    assert.deepEqual(L.allLabels(), { s1: { alpha: { owner: "kim" } } });
  });
  test("another server's write to the shared file is read at the next request", () => {
    L.setLabels("s1", "/p", "alpha", { owner: "kim" });
    const pairs = L.parseLabelPairs("alpha:owner")!;
    assert.deepEqual(L.withLabels([row("s1")], pairs)[0]!.labels, { alpha: { owner: "kim" } });
    writeFileSync(storeFile, JSON.stringify({ version: 1, sessions: { s1: { alpha: { owner: "lee" } } } }) + " ");
    assert.deepEqual(L.withLabels([row("s1")], pairs)[0]!.labels, { alpha: { owner: "lee" } });
  });
  test("each change tells its listeners once, with the session's path and the extension", () => {
    const heard: unknown[] = [];
    const off = L.onLabelled((e) => heard.push(e));
    L.setLabels("s1", "/s/s1.jsonl", "alpha", { owner: "kim" });
    L.setLabels("s1", "/s/s1.jsonl", "alpha", { owner: "kim" });
    off();
    L.setLabels("s1", "/s/s1.jsonl", "alpha", { owner: "lee" });
    assert.deepEqual(heard, [{ id: "s1", path: "/s/s1.jsonl", extension: "alpha" }]);
  });
});

describe("the overlay", () => {
  test("inert: an empty store reads no row and hands back the same array, bytes unchanged", () => {
    const list = [row("s1"), row("s2")];
    const json = JSON.stringify(list);
    const c = counted(list);
    const out = L.withLabels(c.rows, L.parseLabelPairs("alpha:owner")!);
    assert.equal(out, c.rows);
    assert.equal(c.reads(), 0);
    assert.equal(JSON.stringify(out), json);
  });
  test("only the named pairs, only on rows that hold one; every other row the same object", () => {
    L.setLabels("s1", "/p", "alpha", { owner: "kim", where: "srv" });
    L.setLabels("s2", "/p", "beta", { owner: "lee" });
    const list = [row("s1"), row("s2"), row("s3")];
    const out = L.withLabels(list, L.parseLabelPairs("alpha:owner")!);
    assert.notEqual(out, list);
    assert.deepEqual(out[0]!.labels, { alpha: { owner: "kim" } });
    assert.equal(out[1], list[1]);
    assert.equal(out[2], list[2]);
    // The field is added last, every other field as it was.
    assert.equal(JSON.stringify(out[0]), JSON.stringify({ ...list[0], labels: { alpha: { owner: "kim" } } }));
    // A filter naming nothing that is set: the same array.
    assert.equal(L.withLabels(list, L.parseLabelPairs("gamma:owner")!), list);
  });
  test("memoized per row object while the store and filter stay; a write makes new rows", () => {
    L.setLabels("s1", "/p", "alpha", { owner: "kim" });
    const list = [row("s1")];
    const pairs = L.parseLabelPairs("alpha:owner")!;
    const a = L.withLabels(list, pairs)[0];
    assert.equal(L.withLabels(list, pairs)[0], a);
    L.setLabels("s1", "/p", "alpha", { owner: "lee" });
    assert.deepEqual(L.withLabels(list, pairs)[0]!.labels, { alpha: { owner: "lee" } });
  });
  test("projection cuts a labelled row to a socket's pairs; none takes the field off", () => {
    const r = row("s1", { labels: { alpha: { owner: "kim", where: "x" }, beta: { owner: "lee" } } });
    assert.deepEqual(L.projectLabels(r, L.parseLabelPairs("beta:owner")).labels, { beta: { owner: "lee" } });
    assert.equal("labels" in L.projectLabels(r, null), false);
    assert.equal("labels" in L.projectLabels(r, L.parseLabelPairs("gamma:k")), false);
    const plain = row("s2");
    assert.equal(L.projectLabels(plain, null), plain);
  });
});

describe("a linked computer's rows, passed on to a page that asked", () => {
  test("only the asked pairs, each value as this host would keep it; anything else dropped", () => {
    const pairs = L.parseLabelPairs("alpha:owner")!;
    const big = row("s1", { labels: { alpha: { owner: "kim", where: "x" }, x: { y: "z".repeat(65_536) } } });
    assert.deepEqual(L.peerRowLabels(big, pairs).labels, { alpha: { owner: "kim" } });
    for (const labels of [{ x: { y: "v" } }, { alpha: { owner: "a\nb" } }, { alpha: { owner: "z".repeat(65) } }, { alpha: "kim" }, "kim", { alpha: { owner: 3 } }])
      assert.equal("labels" in L.peerRowLabels(row("s1", { labels } as never), pairs), false, JSON.stringify(labels));
    const plain = row("s2");
    assert.equal(L.peerRowLabels(plain, pairs), plain);
  });
});

describe("POST /api/sessions/labels: an extension's key only", () => {
  const KEY = "ext-key-alpha-0123456789";
  initAuthToken();
  setExtensionKeyCheck({ idOf: (k) => (k === KEY ? "alpha" : null), isKey: (v) => v === KEY, socket() {} });
  const app = new Hono<{ Bindings: { meshPeer?: unknown } }>();
  registerLabelRoutes(app, { pathOfId: async (id) => (id === "s1" ? "/s/s1.jsonl" : null) });
  const post = (headers: Record<string, string>, body: unknown, env: object = {}) =>
    app.fetch(new Request("http://x/api/sessions/labels", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), env);

  test("the key names the namespace; the body can't", async () => {
    const res = await post({ [TOKEN_HEADER]: KEY }, { id: "s1", labels: { owner: "kim" }, extension: "beta" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { id: "s1", labels: { owner: "kim" } });
    assert.deepEqual(L.labelsOf("s1"), { alpha: { owner: "kim" } });
  });
  test("the operator's token, no credential, and any peer-listener request are refused, and nothing is written", async () => {
    for (const [headers, env] of [[{ [TOKEN_HEADER]: sovaToken() }, {}], [{}, {}], [{ [TOKEN_HEADER]: KEY }, { meshPeer: { id: "p" } }]] as const) {
      const res = await post(headers, { id: "s1", labels: { owner: "kim" } }, env);
      assert.equal(res.status, 403);
    }
    assert.equal(existsSync(storeFile), false);
  });
  test("bad bodies and unknown sessions", async () => {
    assert.equal((await post({ [TOKEN_HEADER]: KEY }, { id: "nope", labels: { owner: "kim" } })).status, 404);
    assert.equal((await post({ [TOKEN_HEADER]: KEY }, { id: "s1", labels: { Owner: "kim" } })).status, 400);
    assert.equal((await post({ [TOKEN_HEADER]: KEY }, { id: "../x", labels: {} })).status, 400);
    assert.equal((await post({ [TOKEN_HEADER]: KEY }, { id: "s1" })).status, 400);
  });
  test("the read-back: one chat, or all; never on the peer listener", async () => {
    L.setLabels("s1", "/p", "alpha", { owner: "kim" });
    const one = await app.fetch(new Request("http://x/api/sessions/labels?id=s1"), {});
    assert.deepEqual(await one.json(), { id: "s1", labels: { alpha: { owner: "kim" } } });
    const none = await app.fetch(new Request("http://x/api/sessions/labels?id=s9"), {});
    assert.deepEqual(await none.json(), { id: "s9", labels: {} });
    const all = await app.fetch(new Request("http://x/api/sessions/labels"), {});
    assert.deepEqual(await all.json(), { sessions: { s1: { alpha: { owner: "kim" } } } });
    assert.equal((await app.fetch(new Request("http://x/api/sessions/labels"), { meshPeer: { id: "p" } })).status, 403);
  });
});
