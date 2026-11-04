// Run: pnpm test -- server/mesh/create-cards.test.ts
// Mesh by a Create chat (§chat.create-mode/settings-cards): what `get` reads, and cards that only the person's click
// applies, through the same code the Mesh page's routes run. A peer's answers come over the test wire.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { testApp } from "./app-test-fixtures";
import { fakeWire } from "./peer-wire-test-fixtures";

const tmp = mkdtempSync(join(tmpdir(), "sova-mesh-cards-"));
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
mkdirSync(join(tmp, "agent", "sessions", "live"), { recursive: true });

const { setIdentity } = await import("./localapi");
setIdentity({
  status: async () => ({
    backendState: "Running",
    self: { nodeId: "nA", name: "a.lab", hostName: "a", os: "linux", online: true, tags: [], login: "me", addresses: ["127.0.0.1"] },
    peers: [{ nodeId: "nC", name: "c.lab", hostName: "c", os: "linux", online: true, tags: [], login: "me", addresses: ["127.0.0.2"] }],
  }),
  whois: async () => null,
});

const wire = fakeWire();
const app = await testApp();
const { meshEnabled, meshPeers, meshSelf, readMeshConfig, readMeshSettings, stopMesh } = await import("./index");
const { allows } = await import("./access");
const { setMeshCardPort } = await import("./card-port");
const { OVERSEER_SENDER_HEADER, senderSecret } = await import("../overseer-sender");
const { ownProtocol } = await import("./hello");
const { pageHeaders } = await import("../testing/page");
const { runCreateSettingsTool } = await import("../create-settings-run");
const { sovaCardsInfo } = await import("../sova-settings");
(await import("./links-transfer")).setTarAvailableForTest(true);

const FAKE = "http://127.0.0.1:47031";
wire.serve(FAKE, () => new Response(JSON.stringify({ mesh: 1, id: "b", label: "B", hostname: "b", version: "0", protocol: ownProtocol(), pi: "x", now: Date.now() }), { status: 200 }));

after(() => {
  stopMesh();
  // The wire stays up: a settings save wakes sync, whose calls may still be on their way as the file ends.
  rmSync(tmp, { recursive: true, force: true });
});

const PIN = "ABCDEF0123456789ABCDEF0123456789";
const chat = { sessionId: "c1", projectId: null, noProject: "No project." };
const page = (method: string, path: string, body: unknown) => app.request(path, { method, headers: { "content-type": "application/json", ...pageHeaders() }, body: JSON.stringify(body) });
const get = async () => (await runCreateSettingsTool(chat, { op: "get" })).content[0]!.text;

describe("what a Create chat reads", () => {
  test("off: it says so", async () => {
    assert.match(await get(), /Mesh: off/);
  });

  test("each host's state and access, shell-level said plainly, and never a pin", async () => {
    const r = await page("PUT", "/api/mesh/peers", { peers: [{ id: "b", name: "b.lab", nodeId: "nB", url: FAKE, label: "Bee" }], grants: { b: "sessions" } });
    assert.equal(r.status, 200, await r.clone().text());
    const paired = await page("POST", "/api/mesh/lan/pairings", { id: "p", role: "accept", pin: PIN, grant: "presence" });
    assert.equal(paired.status, 200, await paired.clone().text());
    const text = await get();
    assert.match(text, /Mesh: on/);
    assert.match(text, /Bee \(b\): up; sessions access \(shell-level: it can run anything here\)/);
    assert.match(text, /\(p\): .*presence access.*paired, this computer is dialled/);
    assert.match(text, /Sync: /);
    assert.ok(!text.toUpperCase().includes(PIN), "the pin stays out");
    assert.ok(!/fingerprint/i.test(text), "so does this host's own");
  });
});

describe("cards, applied only by the person's click", () => {
  const propose = async (id: string, value: unknown) => (await runCreateSettingsTool(chat, { op: "propose", why: "Asked.", edits: [{ setting: "sova", id, value }] })).details as { card: { id: string; fingerprint: string; grants: unknown[]; access?: { peer: string; before: string; after: string; changed: boolean; shell: boolean }[] } };
  const asPage = (c: { id: string; fingerprint: string }, headers: Record<string, string> = {}) => app.request("/api/settings/apply", { method: "POST", headers: { "content-type": "application/json", ...(Object.keys(headers).length ? headers : pageHeaders()) }, body: JSON.stringify({ card: c.id, fingerprint: c.fingerprint }) });
  const notPage: Record<string, string>[] = [{ [OVERSEER_SENDER_HEADER]: senderSecret() }, { "x-sova-token": "x" }, { "x-sova-caller": "k" }];

  test("a narrowing waits too, every other caller is refused, and the card shows the whole access", async () => {
    assert.ok(allows("nB" as never, "sessions"));
    const { card } = await propose("mesh.access", { peer: "b", grant: { preset: "presence" } });
    assert.equal(card.grants.length, 0, "it narrows: no approval, but it still waits");
    assert.deepEqual(card.access!.map((r) => [r.peer, r.changed]), [["b", true], ["p", false]], "every computer, the changed one marked");
    assert.equal(card.access![0]!.after, "presence: presence");
    for (const headers of notPage) assert.equal((await asPage(card, headers)).status, 403);
    assert.ok(allows("nB" as never, "sessions"), "nothing changed");
    const r = await asPage(card);
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal(allows("nB" as never, "sessions"), false, "it took effect on the next request, no restart");
  });

  test("a wider grant is one, and `sessions` is said to be shell-level", async () => {
    const { card } = await propose("mesh.access", { peer: "b", grant: { preset: "sessions" } });
    assert.equal(card.grants.length, 1);
    assert.equal(card.access!.find((r) => r.peer === "b")!.shell, true);
    assert.equal((await asPage(card)).status, 200);
  });

  test("linking a computer names its access, resolves on the tailnet, and the route's checks hold", async () => {
    await assert.rejects(propose("mesh.peer-add", { name: "c.lab" }), /Name its access/);
    await assert.rejects(propose("mesh.peer-add", { name: "nobody.lab", preset: "presence" }), /not a node on this tailnet/);
    await assert.rejects(propose("mesh.peer-add", { name: "a.lab", preset: "presence" }), /is this host|not a node/);
    const { card } = await propose("mesh.peer-add", { name: "c.lab", label: "Sea", preset: "presence" });
    assert.deepEqual(card.access!.at(-1), { peer: "c", label: "Sea", before: "none yet", after: "presence: presence", changed: true, shell: false });
    assert.equal(card.grants.length, 1);
    assert.equal(meshPeers().some((p) => p.id === "c"), false, "nothing until Apply");
    assert.equal((await asPage(card)).status, 200);
    assert.equal(meshPeers().find((p) => p.id === "c")!.nodeId, "nC");
    assert.equal(allows("nC" as never, "presence"), true);
    assert.equal(allows("nC" as never, "sessions"), false);
  });

  test("a computer keeps its identity, and removing one ends its access at once", async () => {
    const rows = meshPeers().map((p) => ({ id: p.id }));
    await assert.rejects(propose("mesh.peers", rows.map((r) => ({ ...r, nodeId: "nX" }))), /keeps its identity/);
    await assert.rejects(propose("mesh.peers", [...rows, { id: "new" }]), /mesh\.peer-add/);
    const { card } = await propose("mesh.peers", meshPeers().filter((p) => p.id !== "c").map((p) => ({ id: p.id, ...(p.label ? { label: p.label } : {}), ...(p.url ? { url: p.url } : {}) })));
    assert.equal(card.access!.find((r) => r.peer === "c")!.after, "removed");
    assert.equal((await asPage(card)).status, 200);
    assert.equal(meshPeers().some((p) => p.id === "c"), false);
    assert.equal(meshEnabled(), true);
  });

  test("settings go through the route's checks; only more reaching other computers is a grant", async () => {
    await assert.rejects(propose("mesh.settings", { frontDoorOrder: ["nobody"] }), /not a host here/);
    await assert.rejects(propose("mesh.settings", { peers: [] }), /can't go on a card/);
    const off = await propose("mesh.settings", { sync: { settings: false } });
    assert.equal(off.card.grants.length, 0);
    assert.equal((await asPage(off.card)).status, 200);
    assert.equal(readMeshSettings().sync.settings, false);
    assert.equal((await propose("mesh.settings", { sync: { settings: true } })).card.grants.length, 1);
  });

  test("device actions: a linked computer only; the relay is this computer's and on the local network", async () => {
    await assert.rejects(propose("mesh.browser-access", { host: "stranger", on: true }), /a chat can't act on a computer that isn't/);
    const { card } = await propose("mesh.browser-access", { host: meshSelf().id, on: false });
    assert.equal((await asPage(card)).status, 200);
    await assert.rejects(propose("mesh.relay", { host: "203.0.113.5", port: 9000 }));
    await assert.rejects(propose("mesh.relay", { host: "203.0.113.5", port: 9000, exposure: "internet" }), /internet relay stays on the Mesh page, Dial-out pairings/);
    await assert.rejects(propose("mesh.resync", { peer: "stranger" }), /No computer stranger/);
    await assert.rejects(propose("mesh.resync", { peer: "b" }), /No resync recipe/);
    const relay = await propose("mesh.relay", { host: "127.0.0.1", port: 9000 });
    assert.equal(relay.card.grants.length, 1);
    assert.equal((await asPage(relay.card)).status, 200);
    assert.equal(readMeshConfig()!.self.relay!.port, 9000);
    assert.equal((await propose("mesh.relay", null)).card.grants.length, 0, "stopping being a relay opens nothing");
    // The button starts the recipe that is there, once, on the click.
    const started: string[] = [];
    const commit = "a".repeat(40);
    let lines = ["Bee gets aaaaaaa, the build A runs (3 commits ahead of its bbbbbbb), and restarts onto it.", "Nothing is running on Bee now."];
    setMeshCardPort({ resyncSheet: async () => ({ commit, lines }), resync: async (peer, at) => (started.push(`${peer}@${at}`), { status: 200, body: {} }) });
    await assert.rejects(propose("mesh.resync", { peer: "b", commit: "c".repeat(40) }), /Expected \{peer\}/);
    const resync = await propose("mesh.resync", { peer: "b" });
    assert.deepEqual((resync.card as unknown as { notes: string[] }).notes, lines, "the confirm sheet's own sentences, before Apply");
    assert.deepEqual(started, [], "nothing until Apply");
    // What runs there changes while it waits: the card reads it again, and its fingerprint stands.
    lines = [lines[0]!, "1 turn running on Bee stops when it restarts."];
    const read = (await (await app.request("/api/settings/cards")).json()) as { cards: { id: string; fingerprint: string; notes: string[] }[] };
    const live = read.cards.find((c) => c.id === resync.card.id)!;
    assert.deepEqual(live.notes, lines);
    assert.equal(live.fingerprint, resync.card.fingerprint);
    assert.equal((await asPage(resync.card)).status, 200);
    assert.deepEqual(started, [`b@${commit}`], "the commit the card showed, once");
  });
});

describe("pairing: the fingerprint stays out of every chat", () => {
  const PAIR = "0123456789ABCDEF0123456789ABCDEF";
  const propose = (value: unknown) => runCreateSettingsTool(chat, { op: "propose", why: "Pair it.", edits: [{ setting: "sova", id: "mesh.pairing", value }] });
  const apply = (body: Record<string, unknown>) => app.request("/api/settings/apply", { method: "POST", headers: { "content-type": "application/json", ...pageHeaders() }, body: JSON.stringify(body) });
  /** Every file under the state folder but the two the Mesh page's pairing writes too (a peer's node id is made from its pin). */
  const stateTexts = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return e.name === "sessions" ? [] : stateTexts(p);
      return e.name === "peers.json" || e.name === "mesh-access.json" ? [] : [readFileSync(p, "latin1")];
    });

  test("a chat can't carry one, in any field or shape", async () => {
    await assert.rejects(propose({ id: "q", role: "accept", preset: "presence", pin: PAIR }), /never goes through a chat/);
    await assert.rejects(propose({ id: "q", role: "accept", preset: "presence", pin: "short" }), /can't go on a card/);
    await assert.rejects(propose({ id: "q", role: "accept", preset: "presence", label: PAIR }), /never goes through a chat/);
    await assert.rejects(propose({ id: "q", role: "accept", preset: "presence", label: PAIR.match(/.{4}/g)!.join("-") }), /never goes through a chat/);
    await assert.rejects(propose({ id: "q", role: "accept" }), /Name its access/);
  });

  test("typed on the card only: nothing a chat can read holds it, and the pairing works", async () => {
    const out = await propose({ id: "q", label: "Far", role: "accept", preset: "presence" });
    const d = out.details as { card: { id: string; fingerprint: string; input?: { field: string }; access?: { peer: string }[] } };
    assert.equal(d.card.input?.field, "pin");
    assert.equal(d.card.access!.at(-1)!.peer, "q");
    const refused = await apply({ card: d.card.id, fingerprint: d.card.fingerprint });
    assert.equal(refused.status, 409, "no pin, no pairing");
    const bad = await apply({ card: d.card.id, fingerprint: d.card.fingerprint, input: "nope" });
    assert.equal(bad.status, 409);
    assert.ok(!(await bad.text()).includes("nope"), "a refusal doesn't echo what was typed");
    for (const headers of [{ "x-sova-token": "x" }, { "x-sova-caller": "k" }] as Record<string, string>[]) assert.equal((await app.request("/api/settings/apply", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ card: d.card.id, fingerprint: d.card.fingerprint, input: PAIR }) })).status, 403);
    assert.equal(meshPeers().some((p) => p.id === "q"), false);
    const r = await apply({ card: d.card.id, fingerprint: d.card.fingerprint, input: PAIR });
    const answer = await r.text();
    assert.equal(r.status, 200, answer);
    assert.equal(meshPeers().find((p) => p.id === "q")!.lan!.pin, PAIR, "the pairing is real");
    // Everything a chat could read afterwards.
    const reads = [answer, JSON.stringify(out), await get(), JSON.stringify(sovaCardsInfo()), JSON.stringify((await runCreateSettingsTool(chat, { op: "reference", setting: "mesh.pairing" })).content)];
    for (const text of reads) assert.ok(!text.toUpperCase().includes(PAIR), text.slice(0, 200));
    for (const text of stateTexts(join(tmp, "agent", "sova"))) assert.ok(!text.toUpperCase().includes(PAIR), "no other file keeps it");
  });
});

