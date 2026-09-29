// Run: pnpm exec tsx --test server/share-registry.test.ts. The gateway's registry store and its peer
// routes (§mesh.public/registry), with a throwaway PI_CODING_AGENT_DIR; ~/.pi untouched.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Hono } from "hono";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-share-registry-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sova"), { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

const { GatewayRegistry, gatewayPublicUrl, gatewaySetting, localShareHashes } = await import("./share/registry");
const { mountShareGateway } = await import("./share/gateway-routes");
const { SNAPSHOT_MAX_BYTES } = await import("../shared/public-links");
type RegistrySnapshot = import("../shared/public-links").RegistrySnapshot;
type MeshApi = import("./mesh").MeshApi;

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const H = (c: string) => c.repeat(64);
/** Accepts any object as a snapshot: the shape check is registry-validation's (M2), tested there. */
const passing = (body: unknown) => ({ ok: true as const, snapshot: body as RegistrySnapshot });
const snap = (seq: number, links: RegistrySnapshot["links"], assets: string[] = []): RegistrySnapshot => ({ v: 1, seq, links, assets, ingressPort: 4802 });
const row = (h: string, kind: "h" | "i" | "x" = "h", exp = NOW + DAY) => ({ h, exp, kind });
const URL_ = "https://share.example.com";

let n = 0;
function fresh(validate = passing) {
  const file = join(root, `reg-${++n}.json`);
  return { file, reg: new GatewayRegistry({ file: () => file, validate }) };
}
const everyone = { now: NOW, local: new Set<string>(), live: () => true };

test("a snapshot failing validation changes nothing and is bad-snapshot", () => {
  const { file, reg } = fresh((() => ({ ok: false, error: "bad-snapshot", why: "x" })) as never);
  assert.deepEqual(reg.commit("n1", snap(1, [row(H("a"))]), URL_, everyone), { ok: false, error: "bad-snapshot" });
  assert.equal(reg.seqOf("n1"), null);
  assert.throws(() => statSync(file));
  // The default check is registry-validation's; its M0 stub rejects everything.
  const real = new GatewayRegistry({ file: () => join(root, "real.json") });
  assert.deepEqual(real.commit("n1", snap(1, [row(H("a"))]), URL_, everyone), { ok: false, error: "bad-snapshot" });
});

test("a commit stores the rows at 0600 and acks the stored seq; they route by kind", () => {
  const { file, reg } = fresh();
  assert.deepEqual(reg.commit("n1", snap(3, [row(H("a")), row(H("b"), "i"), row(H("c"), "x")]), URL_, everyone), { ok: true, seq: 3, publicUrl: URL_ });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(reg.seqOf("n1"), 3);
  const live = () => true;
  assert.deepEqual(reg.lookup(H("a"), "h", NOW, live), { nodeId: "n1", ingressPort: 4802 });
  assert.equal(reg.lookup(H("a"), "i", NOW, live), null, "an h row never serves /i");
  assert.deepEqual(reg.lookup(H("b"), "i", NOW, live), { nodeId: "n1", ingressPort: 4802 });
  assert.equal(reg.lookup(H("b"), "h", NOW, live), null, "an i row never serves /h");
  assert.equal(reg.lookup(H("c"), "h", NOW, live), null, "an x row never routes on share paths");
  assert.equal(reg.lookup(H("c"), "i", NOW, live), null);
  // Read back from the file by a new instance.
  const again = new GatewayRegistry({ file: () => file, validate: passing });
  assert.deepEqual(again.lookup(H("a"), "h", NOW, live), { nodeId: "n1", ingressPort: 4802 });
});

test("a stale or equal seq changes nothing and reports the stored seq and collisions", () => {
  const { reg } = fresh();
  reg.commit("n0", snap(1, [row(H("d"))]), URL_, everyone);
  const first = reg.commit("n1", snap(5, [row(H("a")), row(H("d"))]), URL_, everyone);
  assert.deepEqual(first, { ok: true, seq: 5, publicUrl: URL_, collisions: [H("d")] });
  // A retry with the same seq, even with other rows, reports the same answer and stores nothing new.
  assert.deepEqual(reg.commit("n1", snap(5, [row(H("e"))]), URL_, everyone), first);
  assert.deepEqual(reg.commit("n1", snap(2, []), URL_, everyone), first);
  assert.ok(reg.lookup(H("a"), "h", NOW, () => true));
  assert.equal(reg.lookup(H("e"), "h", NOW, () => true), null);
});

test("collisions: the gateway's own links and the first claimant keep a hash; it never moves", () => {
  const { reg } = fresh();
  const ctx = { ...everyone, local: new Set([H("f")]) };
  assert.deepEqual(reg.commit("n1", snap(1, [row(H("a")), row(H("f"))]), URL_, ctx), { ok: true, seq: 1, publicUrl: URL_, collisions: [H("f")] });
  assert.equal(reg.lookup(H("f"), "h", NOW, () => true), null, "a row colliding with a local hash is dropped");
  assert.deepEqual(reg.commit("n2", snap(1, [row(H("a")), row(H("b"))]), URL_, ctx), { ok: true, seq: 1, publicUrl: URL_, collisions: [H("a")] });
  assert.equal(reg.lookup(H("a"), "h", NOW, () => true)?.nodeId, "n1");
  // The first claimant's next snapshot keeps it, whatever n2 pushes meanwhile.
  reg.commit("n2", snap(2, [row(H("a")), row(H("b"))]), URL_, ctx);
  reg.commit("n1", snap(2, [row(H("a"))]), URL_, ctx);
  assert.equal(reg.lookup(H("a"), "h", NOW, () => true)?.nodeId, "n1");
  // Once n1 drops it, n2 gets it only by pushing again: a stored collision is not a claim.
  reg.commit("n1", snap(3, []), URL_, ctx);
  assert.equal(reg.lookup(H("a"), "h", NOW, () => true), null);
  assert.deepEqual(reg.commit("n2", snap(3, [row(H("a")), row(H("b"))]), URL_, ctx), { ok: true, seq: 3, publicUrl: URL_ });
  assert.equal(reg.lookup(H("a"), "h", NOW, () => true)?.nodeId, "n2");
});

test("a removed or unaccepted peer's rows never route and go at the next commit; expired rows never route", () => {
  const { file, reg } = fresh();
  reg.commit("gone", snap(1, [row(H("a"))], ["x.js"]), URL_, everyone);
  reg.commit("n1", snap(1, [row(H("b"), "h", NOW + 1000)]), URL_, everyone);
  const live = (id: string) => id !== "gone";
  assert.equal(reg.lookup(H("a"), "h", NOW, live), null);
  assert.deepEqual(reg.assetSources("x.js", live), []);
  assert.ok(reg.lookup(H("b"), "h", NOW, live));
  assert.equal(reg.lookup(H("b"), "h", NOW + 1000, live), null, "past exp");
  // A removed peer's hash is free for the next claimant, and its rows leave the file.
  assert.deepEqual(reg.commit("n2", snap(1, [row(H("a"))]), URL_, { ...everyone, live }), { ok: true, seq: 1, publicUrl: URL_ });
  const stored = JSON.parse(readFileSync(file, "utf8")) as { hosts: { nodeId: string }[] };
  assert.deepEqual(stored.hosts.map((h) => h.nodeId), ["n1", "n2"]);
});

test("assets: the first host to list a name is its first source", () => {
  const { reg } = fresh();
  reg.commit("n1", snap(1, [], ["a.js"]), URL_, everyone);
  reg.commit("n2", snap(1, [], ["a.js", "b.css"]), URL_, everyone);
  reg.commit("n1", snap(2, [], ["a.js"]), URL_, everyone); // a new snapshot keeps n1's place
  assert.deepEqual(reg.assetSources("a.js", () => true).map((s) => s.nodeId), ["n1", "n2"]);
  assert.deepEqual(reg.assetSources("b.css", () => true).map((s) => s.nodeId), ["n2"]);
});

test("a failed write leaves the store as it was", () => {
  const dir = join(root, "ro");
  mkdirSync(dir);
  const file = join(dir, "reg.json");
  const reg = new GatewayRegistry({ file: () => file, validate: passing });
  reg.commit("n1", snap(1, [row(H("a"))]), URL_, everyone);
  chmodSync(dir, 0o500);
  try {
    assert.throws(() => reg.commit("n1", snap(2, [row(H("b"))]), URL_, everyone));
  } finally {
    chmodSync(dir, 0o700);
  }
  assert.equal(reg.seqOf("n1"), 1);
  assert.ok(reg.lookup(H("a"), "h", NOW, () => true));
  assert.equal(reg.lookup(H("b"), "h", NOW, () => true), null);
});

// ---- the setting seam and the peer routes -------------------------------------------------------

const settingFile = join(root, "agent", "sova", "public-links.json");
function setGateway(file: object | null): void {
  if (file) writeFileSync(settingFile, JSON.stringify(file));
  else rmSync(settingFile, { force: true });
}
const GATEWAY = { version: 1, route: "self", gateway: { publicUrl: URL_, front: "caddy", sharePort: 4802, acceptFrom: ["n1", "n2"] } };

test("the gateway setting: only route self with an https publicUrl; the env pin wins for the URL", () => {
  setGateway(null);
  assert.equal(gatewaySetting(), null);
  assert.equal(gatewayPublicUrl({}), null);
  setGateway({ ...GATEWAY, route: "off" });
  assert.equal(gatewayPublicUrl({}), null);
  setGateway({ ...GATEWAY, gateway: { ...GATEWAY.gateway, publicUrl: "http://share.example.com" } });
  assert.equal(gatewayPublicUrl({}), null);
  setGateway(GATEWAY);
  assert.equal(gatewayPublicUrl({}), URL_);
  assert.equal(gatewayPublicUrl({ SOVA_SHARE_PUBLIC_URL: "https://pinned.example.com/" }), "https://pinned.example.com");
  setGateway(null);
  assert.equal(gatewayPublicUrl({ SOVA_SHARE_PUBLIC_URL: "https://pinned.example.com" }), null, "a pin alone makes no gateway");
});

test("localShareHashes reads both link stores", () => {
  writeFileSync(join(root, "agent", "sova", "baton-links.json"), JSON.stringify({ version: 1, links: [{ hash: H("1") }] }));
  writeFileSync(join(root, "agent", "sova", "person-links.json"), JSON.stringify({ links: [{ hash: H("2"), scope: "owner" }] }));
  assert.deepEqual([...localShareHashes()].sort(), [H("1"), H("2")]);
});

function app(caller: string | null, peers: string[] = ["n1", "n2", "n3"]) {
  const { reg } = fresh();
  const mesh = {
    requestPeer: () => (caller ? { id: caller, nodeId: caller, label: caller, dnsName: "127.0.0.1" } : null),
    peers: () => peers.map((p) => ({ id: p, nodeId: p, label: p, dnsName: "127.0.0.1" })),
  } as unknown as MeshApi;
  const a = new Hono();
  mountShareGateway(a, mesh, reg);
  return { a, reg };
}
const put = (a: Hono, body: string, headers: Record<string, string> = {}) => a.request("/api/peer/share-gateway/links", { method: "PUT", body, headers: { "Content-Type": "application/json", ...headers } });

test("peer routes: not-gateway, not-accepted, no caller", async () => {
  setGateway(null);
  let { a } = app("n1");
  assert.deepEqual([(await a.request("/api/peer/share-gateway/info")).status, await (await a.request("/api/peer/share-gateway/info")).json()], [404, { error: "not-gateway" }]);
  let r = await put(a, JSON.stringify(snap(1, [])));
  assert.deepEqual([r.status, await r.json()], [404, { ok: false, error: "not-gateway" }]);
  setGateway(GATEWAY);
  ({ a } = app("n3"));
  const info = await a.request("/api/peer/share-gateway/info");
  assert.deepEqual(await info.json(), { publicUrl: URL_, accepting: false, seq: null });
  r = await put(a, JSON.stringify(snap(1, [])));
  assert.deepEqual([r.status, await r.json()], [403, { ok: false, error: "not-accepted" }]);
  ({ a } = app(null));
  assert.equal((await a.request("/api/peer/share-gateway/info")).status, 404);
  assert.equal((await put(a, "{}")).status, 404);
});

test("peer routes: the caller keys the rows; the byte cap is enforced before parsing", async () => {
  setGateway(GATEWAY);
  const { a, reg } = app("n1");
  // The M0 validation stub rejects every snapshot until M2 lands; swap in the passing check.
  (reg as unknown as { validate: typeof passing }).validate = passing;
  const r = await put(a, JSON.stringify({ ...snap(4, [row(H("a"))]), nodeId: "n2" }));
  assert.deepEqual(await r.json(), { ok: true, seq: 4, publicUrl: URL_ });
  assert.equal(reg.seqOf("n1"), 4);
  assert.equal(reg.seqOf("n2"), null);
  assert.deepEqual(await (await a.request("/api/peer/share-gateway/info")).json(), { publicUrl: URL_, accepting: true, seq: 4 });
  // Over the cap: refused whole, declared or streamed, and never parsed.
  const big = "x".repeat(SNAPSHOT_MAX_BYTES + 1);
  let parsed = 0;
  const origParse = JSON.parse;
  JSON.parse = ((...args: Parameters<typeof JSON.parse>) => (parsed++, origParse(...args))) as typeof JSON.parse;
  try {
    const over = await put(a, big);
    assert.deepEqual([over.status, await over.text()], [413, JSON.stringify({ ok: false, error: "bad-snapshot" })]);
    const streamed = await a.request("/api/peer/share-gateway/links", {
      method: "PUT",
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(big));
          c.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    assert.equal(streamed.status, 413);
    assert.equal(parsed, 0);
  } finally {
    JSON.parse = origParse;
  }
  const bad = await put(a, "{not json");
  assert.deepEqual([bad.status, await bad.json()], [400, { ok: false, error: "bad-snapshot" }]);
  assert.equal(reg.seqOf("n1"), 4);
});

test("routedHosts: registered hosts, then acceptFrom's; null on a non-gateway", async () => {
  const { routedHosts } = await import("./share/registry");
  const { reg } = fresh();
  reg.commit("n1", snap(1, [row(H("a")), row(H("b"), "i"), row(H("c"), "x"), row(H("d"), "h", NOW - 1)]), URL_, { ...everyone, now: NOW - 10 });
  reg.commit("gone", snap(1, [row(H("e"))]), URL_, { ...everyone, now: NOW - 10 });
  const setting = { publicUrl: URL_, front: "caddy" as const, sharePort: 4802, acceptFrom: ["n1", "n2"] };
  const peers = () => [
    { id: "b", nodeId: "n1", label: "b", dnsName: "127.0.0.1" },
    { id: "c", nodeId: "n2", label: "c", dnsName: "127.0.0.1" },
  ];
  assert.equal(await routedHosts({ setting: () => null, registry: reg, peers, up: async () => true }), null);
  const hosts = await routedHosts({ setting: () => setting, registry: reg, peers, up: async (p) => p.id === "b", now: () => NOW });
  assert.deepEqual(hosts, [
    { nodeId: "n1", peer: "b", links: 2, up: true, lastPushAt: NOW - 10, accepted: true },
    { nodeId: "gone", peer: null, links: 1, up: false, lastPushAt: NOW - 10, accepted: false },
    { nodeId: "n2", peer: "c", links: 0, up: false, lastPushAt: null, accepted: true },
  ]);
});

// ---- review B4: the setting and the stored registry fail closed ---------------------------------

/** Everything console.warn printed while `fn` ran. */
async function warned(fn: () => unknown): Promise<string> {
  const lines: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.warn = orig;
  }
  return lines.join("\n");
}

test("a setting that breaks any contract rule is no gateway, with a warning", async () => {
  const g = GATEWAY.gateway;
  for (const [what, file] of [
    ["unknown top-level key", { ...GATEWAY, extra: 1 }],
    ["unknown gateway key", { ...GATEWAY, gateway: { ...g, extra: 1 } }],
    ["missing front", { ...GATEWAY, gateway: { publicUrl: g.publicUrl, sharePort: 4802, acceptFrom: "all" } }],
    ["bad front", { ...GATEWAY, gateway: { ...g, front: "nginx" } }],
    ["bad port", { ...GATEWAY, gateway: { ...g, sharePort: 70000 } }],
    ["bad acceptFrom", { ...GATEWAY, gateway: { ...g, acceptFrom: [1] } }],
    ["url with a path", { ...GATEWAY, gateway: { ...g, publicUrl: "https://share.example.com/x" } }],
    ["url with userinfo", { ...GATEWAY, gateway: { ...g, publicUrl: "https://a@share.example.com" } }],
    ["bad route", { ...GATEWAY, route: { via: { nodeId: "" } } }],
    ["version", { ...GATEWAY, version: 2 }],
  ] as const) {
    setGateway(file);
    const out = await warned(() => assert.equal(gatewaySetting(), null, what));
    assert.match(out, /public-links\.json ignored/, what);
  }
  writeFileSync(settingFile, "{not json");
  assert.match(await warned(() => assert.equal(gatewaySetting(), null)), /not JSON/);
  setGateway(GATEWAY);
  assert.equal(gatewaySetting()?.publicUrl, URL_);
});

test("a stored registry that breaks any rule routes nothing and is never overwritten", async () => {
  const good = { nodeId: "n1", seq: 1, links: [row(H("a"))], assets: ["a.js"], ingressPort: 4802, collisions: [], at: NOW };
  for (const [what, doc] of [
    ["not JSON", "{oops"],
    ["unknown key", { version: 1, hosts: [{ ...good, extra: 1 }] }],
    ["duplicate node", { version: 1, hosts: [good, { ...good, links: [row(H("b"))] }] }],
    ["duplicate hash", { version: 1, hosts: [good, { ...good, nodeId: "n2" }] }],
    ["bad port", { version: 1, hosts: [{ ...good, ingressPort: 0 }] }],
    ["negative seq", { version: 1, hosts: [{ ...good, seq: -1 }] }],
    ["bad hash", { version: 1, hosts: [{ ...good, links: [row("A".repeat(64))] }] }],
    ["exp too far", { version: 1, hosts: [{ ...good, links: [row(H("a"), "h", NOW + 92 * DAY)] }] }],
    ["bad kind", { version: 1, hosts: [{ ...good, links: [{ h: H("a"), exp: NOW + DAY, kind: "z" }] }] }],
    ["bad asset", { version: 1, hosts: [{ ...good, assets: ["../x.js"] }] }],
    ["duplicate asset", { version: 1, hosts: [{ ...good, assets: ["a.js", "a.js"] }] }],
    ["bad collision", { version: 1, hosts: [{ ...good, collisions: ["x"] }] }],
    ["version", { version: 2, hosts: [good] }],
  ] as const) {
    const { file, reg } = fresh();
    const bytes = typeof doc === "string" ? doc : JSON.stringify(doc);
    writeFileSync(file, bytes);
    const out = await warned(() => assert.equal(reg.lookup(H("a"), "h", NOW, () => true), null, what));
    assert.match(out, /share-gateway\.json is invalid/, what);
    assert.ok(reg.broken(), what);
    assert.equal(reg.seqOf("n1"), null, what);
    assert.throws(() => reg.commit("n1", snap(9, [row(H("c"))]), URL_, everyone), /invalid/, what);
    assert.equal(readFileSync(file, "utf8"), bytes, `${what}: not overwritten`);
  }
  // The valid document restores and routes; removing the broken file recovers.
  const { file, reg } = fresh();
  writeFileSync(file, JSON.stringify({ version: 1, hosts: [good] }));
  assert.deepEqual(reg.lookup(H("a"), "h", NOW, () => true), { nodeId: "n1", ingressPort: 4802 });
  writeFileSync(file, "{oops");
  await warned(() => assert.equal(reg.lookup(H("a"), "h", NOW, () => true), null, "a file changed on disk is re-read"));
  rmSync(file);
  assert.equal(reg.broken(), null);
});

test("the links route: a broken store is 503 and a commit rechecks the caller's acceptance", async () => {
  setGateway(GATEWAY);
  const { a, reg } = app("n1");
  (reg as unknown as { validate: typeof passing }).validate = passing;
  assert.deepEqual(reg.commit("n1", snap(1, []), URL_, { ...everyone, live: () => false }), { ok: false, error: "not-accepted" });
  assert.equal(reg.seqOf("n1"), null);
  const file = (reg as unknown as { file: () => string }).file();
  writeFileSync(file, "{oops");
  await warned(async () => {
    const r = await put(a, JSON.stringify(snap(2, [])));
    assert.deepEqual([r.status, await r.json()], [503, { error: "registry-unavailable" }]);
  });
  assert.equal(readFileSync(file, "utf8"), "{oops");
});

test("the links route: acceptance withdrawn while the body arrives commits nothing", async () => {
  setGateway(GATEWAY);
  const { a, reg } = app("n1");
  (reg as unknown as { validate: typeof passing }).validate = passing;
  let push!: (s: string) => void;
  let end!: () => void;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      push = (s) => c.enqueue(new TextEncoder().encode(s));
      end = () => c.close();
    },
  });
  const pending = a.request("/api/peer/share-gateway/links", { method: "PUT", body, duplex: "half", headers: { "Content-Type": "application/json" } } as RequestInit);
  const text = JSON.stringify(snap(1, [row(H("a"))]));
  push(text.slice(0, 10));
  await new Promise((r) => setTimeout(r, 20));
  setGateway({ ...GATEWAY, gateway: { ...GATEWAY.gateway, acceptFrom: ["n2"] } });
  push(text.slice(10));
  end();
  const r = await pending;
  assert.deepEqual([r.status, await r.json()], [403, { ok: false, error: "not-accepted" }]);
  assert.equal(reg.seqOf("n1"), null);
});

// ---- re-review B4: the public URL is an https origin, judged on the parsed URL -------------------

test("isPublicUrl: only the canonical https origin; a spelling the parser would normalize is refused", async () => {
  const { isPublicUrl } = await import("./share/registry");
  const { parsePublicLinks } = await import("./public-links");
  for (const ok of ["https://share.example.com", "https://share.example.com:8443", "https://[fd7a:115c:a1e0::1]", "https://xn--bcher-kva.example"]) assert.equal(isPublicUrl(ok), true, ok);
  for (const bad of [
    "https://share.example.com\\private",
    "https://share.example.com\\",
    "https://share.example.com\\\\x",
    "https:\\\\share.example.com",
    "https://share.example.com/",
    "https://share.example.com/x",
    "https://share.example.com/%2e%2e",
    "https://share.example.com?",
    "https://share.example.com?a=b",
    "https://share.example.com#",
    "https://share.example.com#x",
    "https://a@share.example.com",
    "https://a:b@share.example.com",
    "https://:@share.example.com",
    "https://share.example.com:443",
    "https://SHARE.example.com",
    "https://share.exa\tmple.com",
    "https://share.example.com\n",
    " https://share.example.com",
    "https://bücher.example",
    "https://share.example.com.:8443/",
    "https:share.example.com",
    "http://share.example.com",
    "HTTPS://share.example.com",
    "https://",
    // Core's table (server/public-links.test.ts), the same rule:
    "https://host\\evil",
    "https://host\\@other",
    "https://host\\",
    "https://sha\nre.example.com",
    "https://share.example.com\t/",
    "https://share.example.com/.",
    "https://share.example.com/%2e",
    "https://share.example.com//",
    "https:/share.example.com",
    "https:///share.example.com",
    "https://user@share.example.com",
  ])
    assert.equal(isPublicUrl(bad), false, JSON.stringify(bad));
  const withBackslash = { ...GATEWAY, gateway: { ...GATEWAY.gateway, publicUrl: "https://share.example.com\\private" } };
  assert.throws(() => parsePublicLinks(withBackslash), "the setting's own reader refuses it too");
});

test("the gateway's address follows the setting's pin rule (sharePin): a refused pin is no pin", async () => {
  setGateway(GATEWAY);
  const out = await warned(() => {
    assert.equal(gatewayPublicUrl({ SOVA_SHARE_PUBLIC_URL: "https://pinned.example.com\\x" }), URL_, "a backslash pin is ignored: the setting decides");
    assert.equal(gatewayPublicUrl({ SOVA_SHARE_PUBLIC_URL: "https://pinned.example.com/x" }), URL_);
  });
  assert.match(out, /SOVA_SHARE_PUBLIC_URL ignored/);
  assert.equal(gatewayPublicUrl({ SOVA_SHARE_PUBLIC_URL: "https://pinned.example.com/" }), "https://pinned.example.com");
});
