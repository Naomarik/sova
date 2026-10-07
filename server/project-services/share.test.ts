// Share links to a running copy (§app.project-services/share, §mesh.public/preview): share, revoke, who may,
// the link's life (down, teardown, siblings), the refusals, a static copy's dial guard and the sensitive rule on
// the port-preview path. On a host in memory (fake-host.ts), `site` a process service here; a temp
// PI_CODING_AGENT_DIR; the preview address pinned by env; ~/.pi untouched. A static copy's dial guard and conform's
// share-endpoint check, over real sockets, are in share.integration.test.ts.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { DefinitionError, isVerbResult, parseDefinition, type VerbResult } from "../../shared/project-contract";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "sova-share-agent-"));
process.env.SOVA_SHARE_PREVIEW_URL = "https://*.preview.example.invalid";

const { FakeHost } = await import("./fake-host");
const { ProjectEngine } = await import("./engine");
type Caller = import("./engine").Caller;
const { readRegistry, sharedIdOf } = await import("./store");
const { approve, defHashOf } = await import("./trust");
const links = await import("../preview-links");
const { keptPreview } = await import("../preview-kept");
const { sensitivePortRefusal } = await import("./sensitive");
const { linksOf } = await import("./share");
const { renderResult } = await import("./tools");

const op: Caller = { kind: "operator" };
const BASE = 21_000;
const PORTS = { web: BASE, site: BASE + 20, db: BASE + 40 };
const PID = "prj_sharetst";

const DEF = {
  version: 1,
  services: {
    db: { cmd: ["node", "db.mjs"], scope: "shared", ports: { tcp: { fixed: PORTS.db } } },
    web: { cmd: ["node", "web.mjs"], ports: { http: { base: PORTS.web }, admin: { base: PORTS.web + 10 } }, ready: { http: "http", timeout: 20 } },
    site: { cmd: ["node", "site.mjs"], ports: { http: { base: PORTS.site } } },
  },
  share: { endpoints: ["web.http", "site.http"], maxDays: 5 },
};
const FILES: Record<string, string> = {
  "db.mjs": `import { createServer } from "node:net"; createServer((s) => s.end()).listen(Number(process.env.SOVA_PORT_TCP), "127.0.0.1");`,
  // Every declared port listens (§app.project-services/contract): admin too, though it is never shared.
  "web.mjs": `import { createServer } from "node:http"; createServer((q, r) => r.end("web")).listen(Number(process.env.SOVA_PORT_HTTP), "127.0.0.1"); createServer((q, r) => r.end("admin")).listen(Number(process.env.SOVA_PORT_ADMIN), "127.0.0.1");`,
  "public/index.html": "<h1>site</h1>",
};

let parent = "";
let project = "";
let registered: string | null = PID;
const engine = new ProjectEngine(new FakeHost().deps({ projectIdOf: async () => registered }));
const git = (args: string[], cwd = project) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
const shaped = (r: VerbResult) => {
  assert.ok(isVerbResult(r), `result shape: ${JSON.stringify(r).slice(0, 400)}`);
  return r;
};
const write = (def: unknown) => writeFileSync(join(project, ".sova", "project.json"), JSON.stringify(def, null, 2));
const approveNow = (dir = project) => {
  const h = defHashOf(parseDefinition(JSON.stringify(DEF)));
  approve(dir, h, h);
};

before(() => {
  parent = realpathSync(mkdtempSync(join(tmpdir(), "sova-share-proj-")));
  project = join(parent, "demo");
  mkdirSync(join(project, ".sova"), { recursive: true });
  mkdirSync(join(project, "public"));
  for (const [f, body] of Object.entries(FILES)) writeFileSync(join(project, f), body);
  write(DEF);
  git(["init", "-q", "-b", "main"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture"]);
  approveNow();
});

after(async () => {
  for (const i of readRegistry().instances) if (i.slot !== 0) await engine.run("teardown", { instance: i.id, confirm: true }, op);
  await engine.driver.stop(engine.unitOf(sharedIdOf(project), "db"));
  rmSync(parent, { recursive: true, force: true });
  rmSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true, force: true });
});

let a: VerbResult;

test("the contract: share.endpoints name a copy's own declared ports; maxDays 1–7; allow false or true; shared services never", () => {
  const def = parseDefinition(JSON.stringify(DEF));
  assert.deepEqual(def.share, { endpoints: ["web.http", "site.http"], maxDays: 5 });
  assert.equal(def.deploy, undefined, "no deploy declared");
  const bad = (share: unknown, re: RegExp) => assert.throws(() => parseDefinition(JSON.stringify({ ...DEF, share })), (e: unknown) => e instanceof DefinitionError && re.test(e.message));
  bad({ endpoints: ["db.tcp"] }, /share\.endpoints\[0\]: a shared service is never shared/);
  bad({ endpoints: ["web.nope"] }, /names no declared port/);
  bad({ endpoints: ["web"] }, /must be "<service>\.<port>"/);
  bad({ endpoints: ["web.http", "web.http"] }, /each endpoint once/);
  bad({ endpoints: [], maxDays: 8 }, /maxDays: must be an integer from 1 to 7/);
  bad({ endpoints: [], group: "ab" }, /share\.group: unknown key/);
  // allow: true is the default and hashes as without it.
  const plain = defHashOf(parseDefinition(JSON.stringify(DEF)));
  assert.equal(defHashOf(parseDefinition(JSON.stringify({ ...DEF, share: { ...DEF.share, allow: true } }))), plain);
  assert.notEqual(defHashOf(parseDefinition(JSON.stringify({ ...DEF, share: { ...DEF.share, endpoints: ["web.http"] } }))), plain, "the endpoints are in the hash");
});

test("share needs a running copy and the operator's confirm; the link is a port preview of the endpoint, kept with its instance", async () => {
  a = shaped(await engine.run("create", { project, branch: "sova/a" }, op));
  assert.equal(a.ok, true, JSON.stringify(a.error));
  const stopped = shaped(await engine.run("share", { instance: a.instance, endpoint: "web.http", confirm: true }, op));
  assert.equal(stopped.error?.code, "share-denied");
  assert.match(stopped.error!.message, /isn't running web: start it first \(up\); sharing never starts anything/);
  assert.equal(shaped(await engine.run("status", { instance: a.instance }, op)).state, "stopped", "nothing was started");
  assert.equal(shaped(await engine.run("up", { instance: a.instance }, op)).ok, true);
  const unconfirmed = shaped(await engine.run("share", { instance: a.instance, endpoint: "web.http" }, op));
  assert.equal(unconfirmed.error?.code, "needs-confirm");
  assert.equal(links.listPreviews({}).length, 0);
  const r = shaped(await engine.run("share", { instance: a.instance, endpoint: "web.http", confirm: true }, op));
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.links.length, 1);
  const l = r.links[0]!;
  assert.deepEqual([l.instance, l.endpoint, l.port, l.state, l.createdBy], [a.instance, "web.http", PORTS.web + 1, "active", "operator"]);
  assert.match(l.url ?? "", /^https:\/\/[a-z2-7]{52}\.preview\.example\.invalid\/$/);
  assert.ok(Math.abs(Date.parse(l.expiresAt) - Date.now() - 86_400_000) < 60_000, "one day by default");
  assert.deepEqual(keptPreview(l.id)?.target, { kind: "instance", instance: a.instance, endpoint: "web.http", generation: 1 });
  assert.equal(links.listPreviews({ projectId: PID })[0]?.port, PORTS.web + 1, "a port preview of the copy's slot port");
});

test("sharing again answers the same link, its expiry the later; days beyond the cap are refused", async () => {
  const first = linksOf(a.instance!)[0]!;
  const again = shaped(await engine.run("share", { instance: a.instance, endpoint: "web.http", days: 3, confirm: true }, op));
  assert.equal(again.links[0]?.id, first.id);
  assert.ok(Date.parse(again.links[0]!.expiresAt) > Date.parse(first.expiresAt));
  const shorter = shaped(await engine.run("share", { instance: a.instance, endpoint: "web.http", days: 1, confirm: true }, op));
  assert.equal(shorter.links[0]?.expiresAt, again.links[0]?.expiresAt, "never shortened");
  assert.equal(shorter.changed, false);
  for (const days of [0, 6, 8]) {
    const r = shaped(await engine.run("share", { instance: a.instance, endpoint: "web.http", days, confirm: true }, op));
    assert.equal(r.error?.code, "invalid-request", String(days));
    assert.match(r.error!.message, /lasts 1 to 5 days/);
  }
  assert.throws(() => links.extendPreview(first.id, 8), /A running copy's link lasts 1 to 7 days\./);
  assert.ok(links.extendPreview(first.id, 7));
});

test("who shares: the operator confirmed, the project overseer through its act; the global Overseer needs the operator; a session never", async () => {
  const ov = shaped(await engine.run("share", { instance: a.instance, endpoint: "web.http" }, { kind: "overseer", id: "ov1" }));
  assert.equal(ov.error?.code, "needs-confirm");
  assert.equal(ov.error?.message, "The operator shares it from the project's Branches tab.");
  const se = shaped(await engine.run("share", { instance: a.instance, endpoint: "web.http" }, { kind: "session", id: "s1", root: project, own: [a.checkout!] }));
  assert.equal(se.error?.code, "forbidden");
  const acts: unknown[][] = [];
  const held = shaped(
    await engine.run("share", { instance: a.instance, endpoint: "site.http", days: 2 }, { kind: "project-overseer", id: "po1", root: project, act: async (...args) => (acts.push(args), { held: "Held for the operator's approval." }) }),
  );
  assert.equal(held.ok, true);
  assert.deepEqual([...acts], [["share", a.instance, { endpoint: "site.http", days: 2 }]]);
  assert.deepEqual(held.links, []);
  assert.equal(held.steps.at(-1)?.detail, "Held for the operator's approval.");
  assert.match(renderResult(held), /^share: Held for the operator's approval\.\n/);
  assert.equal(linksOf(a.instance!).filter((l) => l.endpoint === "site.http").length, 0, "nothing minted while held");
  // A refused share never reaches the statechart.
  const refused = shaped(await engine.run("share", { instance: a.instance, endpoint: "web.admin" }, { kind: "project-overseer", id: "po1", root: project, act: async (...args) => void acts.push(args) }));
  assert.equal(refused.error?.code, "share-denied");
  assert.equal(acts.length, 1);
  // Taken (or released): the act's effect runs the share again with a pass-through act; the link has no url for it.
  const made = shaped(await engine.run("share", { instance: a.instance, endpoint: "site.http", days: 2 }, { kind: "project-overseer", id: "po1", root: project, act: async () => undefined }));
  assert.equal(made.ok, true, JSON.stringify(made.error));
  assert.equal(made.links[0]?.createdBy, "session:po1", "preview-links.json keeps the overseer as its conversation");
  assert.equal(made.links[0]?.url, undefined);
  assert.deepEqual(keptPreview(made.links[0]!.id)?.target, { kind: "instance", instance: a.instance, endpoint: "site.http", generation: 1 });
  // Status lists each copy's links; the url only for the operator, and no tool result carries one.
  const mine = shaped(await engine.run("status", { project }, op)).instances!.find((i) => i.instance === a.instance)!;
  assert.deepEqual(mine.links.map((l) => [l.endpoint, !!l.url]), [["web.http", true], ["site.http", true]]);
  assert.deepEqual(mine.share, { endpoints: ["web.http", "site.http"], refused: null });
  const theirs = shaped(await engine.run("status", { project }, { kind: "overseer", id: "ov1" }));
  const text = renderResult(theirs);
  assert.ok(!/preview\.example\.invalid/.test(text), "no URL in a tool result");
  assert.equal(theirs.instances!.find((i) => i.instance === a.instance)!.links.length, 2);
});

test("down of a linked copy needs the operator's confirm; its links stay and a visit starts nothing", async () => {
  const d = shaped(await engine.run("down", { instance: a.instance }, op));
  assert.equal(d.error?.code, "needs-confirm");
  assert.match(d.error!.message, /2 active share links/);
  const ov = shaped(await engine.run("down", { instance: a.instance, confirm: true }, { kind: "overseer", id: "ov1" }));
  assert.equal(ov.error?.code, "needs-confirm", "only the operator confirms");
  const ok = shaped(await engine.run("down", { instance: a.instance, confirm: true }, op));
  assert.equal(ok.ok, true, JSON.stringify(ok.error));
  assert.equal(linksOf(a.instance!, { activeOnly: true }).length, 2, "links survive down");
  assert.equal(shaped(await engine.run("status", { instance: a.instance }, op)).state, "stopped");
  assert.equal(shaped(await engine.run("up", { instance: a.instance }, op)).ok, true);
});

test("revoke: by link or by instance (and endpoint), open to any caller in scope, never an act; idempotent", async () => {
  const site = linksOf(a.instance!).find((l) => l.endpoint === "site.http")!;
  const outsider = shaped(await engine.run("revoke", { link: site.id }, { kind: "session", id: "s1", root: project, own: [] }));
  assert.equal(outsider.error?.code, "forbidden");
  let acted = 0;
  const r = shaped(await engine.run("revoke", { link: site.id }, { kind: "project-overseer", id: "po1", root: project, act: async () => void acted++ }));
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(acted, 0, "no act");
  assert.deepEqual(r.links.map((l) => [l.id, l.state]), [[site.id, "revoked"]]);
  assert.equal(r.changed, true);
  const again = shaped(await engine.run("revoke", { link: site.id }, op));
  assert.equal(again.changed, false);
  assert.equal(shaped(await engine.run("revoke", { link: "pv_AAAAAAAAAAAAAAAA" }, op)).error?.code, "not-found");
  const own = shaped(await engine.run("revoke", { instance: a.instance, endpoint: "site.http" }, { kind: "session", id: "s1", root: project, own: [a.checkout!] }));
  assert.equal(own.ok, true, JSON.stringify(own.error));
});

test("teardown ends every link of the copy and each person's sibling, before its slot is freed", async () => {
  const web = linksOf(a.instance!, { activeOnly: true }).find((l) => l.endpoint === "web.http")!;
  const sib = links.mintSibling(web.id, "per_ana").record;
  const t = shaped(await engine.run("teardown", { instance: a.instance }, op));
  assert.equal(t.ok, true, JSON.stringify(t.error));
  assert.equal(t.steps[0]?.id, "links");
  const states = Object.fromEntries(links.listPreviews({}).map((v) => [v.id, v.state]));
  assert.equal(states[web.id], "off");
  assert.equal(states[sib.id], "off");
  // A new copy in the same slot never answers the old link.
  const b = shaped(await engine.run("up", { project, branch: "sova/b" }, op));
  assert.equal(b.slot, a.slot);
  assert.equal(links.listPreviews({}).filter((v) => v.state === "active").length, 0);
  assert.equal(shaped(await engine.run("teardown", { instance: b.instance }, op)).ok, true);
});

test("refused shares: unregistered, no share key, allow false, sensitive data, an undeclared endpoint", async () => {
  const c = shaped(await engine.run("up", { project, branch: "sova/c" }, op));
  assert.equal(c.ok, true, JSON.stringify(c.error));
  const ask = () => engine.run("share", { instance: c.instance, endpoint: "web.http", confirm: true }, op);
  registered = null;
  assert.match((await ask()).error?.message ?? "", /^Only a registered project's copies can be shared\.$/);
  registered = PID;
  assert.equal((await engine.run("share", { instance: c.instance, endpoint: "web.admin", confirm: true }, op)).error?.code, "share-denied");
  const variants: [unknown, RegExp][] = [
    [{ ...DEF, share: undefined }, /lists no share endpoints/],
    [{ ...DEF, share: { ...DEF.share, allow: false } }, /share\.allow: false/],
    [{ ...DEF, data: { prod: { kind: "dir", sensitive: true } } }, /^Derived from production: copies are never shared\.$/],
  ];
  for (const [def, re] of variants) {
    writeFileSync(join(c.checkout!, ".sova", "project.json"), JSON.stringify(def));
    const h = defHashOf(parseDefinition(JSON.stringify(def)));
    approve(project, h, h);
    const r = shaped(await ask());
    assert.equal(r.error?.code, "share-denied", String(re));
    assert.match(r.error!.message, re);
  }
  // The sensitive copy's ports are refused on the port-preview path too.
  assert.match(sensitivePortRefusal(c.services.find((s) => s.name === "web")!.ports.http!) ?? "", /derived from production/);
  assert.equal(sensitivePortRefusal(1), null);
  writeFileSync(join(c.checkout!, ".sova", "project.json"), JSON.stringify(DEF));
  assert.equal(sensitivePortRefusal(c.services.find((s) => s.name === "web")!.ports.http!), null);
});
