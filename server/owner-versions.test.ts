// Run: pnpm test server/owner-versions.test.ts. Versions you can try (§app.project-assistant/versions):
// the current version and the running fixes of a shown project, named without branches, openable
// only where a copy can be shared, through an owner-bound preview that follows the owner link's
// deadline and ends with it; never an address in the page's data. A throwaway state root, a
// stand-in registry and dial; nothing is started.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-owner-versions-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.SOVA_SHARE_PREVIEW_URL = "https://*.preview.example";
mkdirSync(join(root, "agent", "sessions"), { recursive: true });

const orgs = await import("./orgs");
const owner = await import("./owner");
const plinks = await import("./person-links");
const versions = await import("./owner-versions");
const store = await import("./project-assistant-store");
const { ownerHome } = await import("./owner-page");
const { listPreviews } = await import("./preview-links");
const { keptPreviews } = await import("./preview-kept");
const { registryFile } = await import("./project-services/store");

after(() => rmSync(root, { recursive: true, force: true }));

const DAY = 86_400_000;
const site = join(root, "site");
const fixTree = join(root, "site-fix");
const otherTree = join(root, "site-other");
for (const d of [site, fixTree, otherTree]) mkdirSync(join(d, ".sova"), { recursive: true });
const DEF = { version: 1, services: { web: { cmd: ["node", "web.mjs"], ports: { http: { base: 23_000 } } } }, share: { endpoints: ["web.http"] } };
for (const d of [site, fixTree, otherTree]) writeFileSync(join(d, ".sova", "project.json"), JSON.stringify(DEF));
// The main checkout is a repository on master (an unborn branch is enough: only HEAD's name counts).
const git = (...a: string[]) => execFileSync("git", ["-c", "init.defaultBranch=master", ...a], { cwd: site, stdio: "pipe", encoding: "utf8" });
git("init", "-q");

const org = await orgs.createOrg({ name: "Mamluk Arabia", dir: join(root, "ws") });
const alp = await orgs.addPerson(org.id, { name: "Alperen Kaya", role: "Founder" });
await owner.setOwner(org.id, alp.id);
const proj = await orgs.addProject(org.id, { name: "Archery website", root: site });

const inst = (id: string, checkout: string, slot: number, createdAt: string, branch: string | null) => ({
  id,
  project: site,
  checkout,
  branch,
  slot,
  generation: 1,
  createdBy: "operator",
  createdAt,
  cutWorktree: false,
  desired: { web: "running" },
  prints: {},
  data: {},
  ports: { web: { http: 23_000 + slot } },
});
mkdirSync(join(root, "agent", "sova", "project-services"), { recursive: true });
writeFileSync(
  registryFile(),
  JSON.stringify({
    version: 1,
    instances: [inst("i_main", site, 0, "2026-10-01T00:00:00.000Z", null), inst("i_fix", fixTree, 1, "2026-10-10T00:00:00.000Z", "sova/fix-the-bow-page"), inst("i_other", otherTree, 2, "2026-10-12T00:00:00.000Z", "sova/secret-branch")],
    shared: [],
  }),
);
versions.setVersionTreesForTest(async () => [
  { sessionId: "s_fix", branch: "sova/fix-the-bow-page", path: fixTree, title: "CODING-TITLE fix", sessionPath: null },
  { sessionId: "s_other", branch: "sova/secret-branch", path: otherTree, title: "CODING-TITLE other", sessionPath: null },
]);
let up = new Set([23_000, 23_001, 23_002]);
versions.setVersionDialForTest(async (port) => up.has(port));
const req = store.fileRequest(org.id, { projectId: proj.id, kind: "fix", title: "The bow page is slow", text: "It takes ages." });
store.setRequestStatus(org.id, req.id, "started", { sessionId: "s_fix" });

describe("Versions you can try", () => {
  test("current first, a fix the owner asked for by its request's title, the team's own work as work in progress; no branch, title or port", async () => {
    const vs = await versions.projectVersions(org.id, proj);
    assert.deepEqual(
      vs.map((v) => [v.label, v.running]),
      [
        ["Current version", true],
        ["Fix: The bow page is slow", true],
        ["Work in progress · started Oct 12", true],
      ],
    );
    const home = await ownerHome(org.id);
    const text = JSON.stringify(home);
    for (const no of ["sova/", "CODING-TITLE", "23000", "23001", "preview.example", "i_main", req.id]) assert.ok(!text.includes(no), `no ${no} on the page`);
    assert.equal(home.versions!.length, 3);
    assert.match(home.versions![0]!.handle, /^v_[a-z2-9]{8}$/);
    assert.equal(home.requests![0]!.title, "The bow page is slow");
    assert.equal(home.requests![0]!.status, "started");
  });

  test("a project named after its org keeps its name on the row; a model's words in a label still pass the outsider filter", async () => {
    const { outsiderRedactor } = await import("./share/hub");
    const r = outsiderRedactor(org.id);
    const vs = await versions.projectVersions(org.id, { ...proj, name: "Mamluk Arabia website" });
    const rows = versions.versionRows(vs, r);
    assert.deepEqual([...new Set(rows.map((v) => v.project))], ["Mamluk Arabia website"], "the operator's project name is no model text");
    const said = versions.versionRows([{ ...vs[1]!, label: "Fix: Mamluk Arabia's bow page" }], r)[0]!.label;
    assert.notEqual(said, "Fix: Mamluk Arabia's bow page", "a request title in a label is a model's words: filtered");
  });

  test("the main checkout on another branch is no current version: nothing is served from that branch", async () => {
    git("symbolic-ref", "HEAD", "refs/heads/x");
    try {
      const vs = await versions.projectVersions(org.id, proj);
      assert.deepEqual(vs.map((v) => v.label), ["Fix: The bow page is slow", "Work in progress · started Oct 12"]);
      assert.ok(!vs.some((v) => v.rec.id === "i_main"), "the main checkout's copy is not offered");
      const home = await ownerHome(org.id);
      assert.ok(!home.versions!.some((v) => v.label === "Current version"));
    } finally {
      git("symbolic-ref", "HEAD", "refs/heads/master");
    }
    git("symbolic-ref", "HEAD", "refs/heads/main");
    try {
      assert.equal((await versions.projectVersions(org.id, proj))[0]!.label, "Current version", "main is the trunk where no master branch exists");
    } finally {
      git("symbolic-ref", "HEAD", "refs/heads/master");
    }
  });

  test("a copy that doesn't answer is not running; a sensitive or unshareable project lists nothing openable", async () => {
    up = new Set([23_000]);
    assert.deepEqual((await versions.projectVersions(org.id, proj)).map((v) => v.running), [true, false, false]);
    up = new Set([23_000, 23_001, 23_002]);
    writeFileSync(join(site, ".sova", "project.json"), JSON.stringify({ ...DEF, data: { db: { kind: "dir", sensitive: true } } }));
    assert.deepEqual((await versions.projectVersions(org.id, proj)).map((v) => v.running), [false, false, false], "the main definition's sensitive data closes every copy");
    writeFileSync(join(site, ".sova", "project.json"), JSON.stringify(DEF));
  });

  test("Open makes one owner-bound preview per copy, at the link's deadline; a use moves it; rotation ends it", async () => {
    const { token } = plinks.mintOwnerLink(org.id, alp.id);
    const a = owner.ownerAccess(token);
    assert.ok(a.ok);
    const [current] = await versions.projectVersions(org.id, proj);
    const url = await versions.openVersion(current!, a.link);
    assert.match(url!, /^https:\/\/[a-z2-7]{52}\.preview\.example\/$/);
    assert.equal(await versions.openVersion(current!, a.link), url, "kept, not made again");
    const mine = () => listPreviews({ projectId: proj.id }).filter((p) => keptPreviews()[p.id]?.owner === a.link.hash);
    assert.equal(mine().length, 1);
    assert.equal(mine()[0]!.expiresAt, a.link.expiresAt, "exactly the link's deadline");
    plinks.noteOwnerLinkUse(a.link.hash, Date.now() + 2 * 3_600_000);
    assert.equal(mine()[0]!.expiresAt, plinks.findPersonLink(token)!.expiresAt, "follows a use");
    plinks.mintOwnerLink(org.id, alp.id);
    assert.equal(mine()[0]!.state, "off", "a new owner link ends the old one's versions");
  });

  test("turning the owner link off ends its versions", async () => {
    const { token } = plinks.mintOwnerLink(org.id, alp.id);
    const a = owner.ownerAccess(token);
    assert.ok(a.ok);
    const [current] = await versions.projectVersions(org.id, proj);
    await versions.openVersion(current!, a.link);
    owner.revokeOwnerLinks(org.id);
    assert.ok(listPreviews({ projectId: proj.id }).filter((p) => keptPreviews()[p.id]?.owner === a.link.hash).every((p) => p.state === "off"));
  });

  test("starting: a copy start_version started reads starting until it answers, then running; failed past the timeout or when its start failed", async () => {
    const { createShareApp } = await import("./share/routes");
    const share = createShareApp();
    const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1";
    const get = (path: string) => share.request(path, { headers: { "user-agent": UA } });
    const { token } = plinks.mintOwnerLink(org.id, alp.id);
    const fixOf = async () => (await versions.projectVersions(org.id, proj)).find((v) => v.rec.id === "i_fix")!;
    const rowOf = async () => (await ownerHome(org.id)).versions!.find((v) => v.label === "Fix: The bow page is slow")!;
    // The fix's port refuses its first dials, as a copy still booting does.
    let refusals = 2;
    versions.setVersionDialForTest(async (p) => (p === 23_001 ? refusals-- <= 0 : up.has(p)));
    try {
      versions.noteVersionStarting("i_fix");
      const row = await rowOf();
      assert.equal(row.state, "starting", "Home shows it starting");
      const early = await get(`/i/${token}/v/${row.handle}`);
      assert.equal(early.status, 200, "an early Open is no refusal");
      assert.equal(early.headers.get("refresh"), "3");
      assert.match(await early.text(), /Starting this version…[\s\S]*This page opens it as soon as it's ready\./);
      const late = await get(`/i/${token}/v/${row.handle}`);
      assert.equal(late.status, 302, "once it answers, on to the copy");
      assert.equal((await fixOf()).state, "running");
      // Its mark is gone once it ran: a later stop reads not running, never starting.
      versions.setVersionDialForTest(async (p) => p !== 23_001 && up.has(p));
      assert.equal((await fixOf()).state, "not-running");
      versions.noteVersionStarting("i_fix", Date.now() - versions.START_TIMEOUT_MS - 1);
      assert.equal((await fixOf()).state, "failed", "no answer 5 minutes after the start");
      const failed = await get(`/i/${token}/v/${(await rowOf()).handle}`);
      assert.deepEqual([failed.status, await failed.text()], [409, "This version didn't start. The team knows."]);
      versions.noteVersionStarting("i_fix");
      versions.noteVersionFailed("i_fix");
      assert.equal((await rowOf()).state, "failed", "a start that failed");
      assert.ok(!JSON.stringify(await ownerHome(org.id)).includes("23001"), "no port on the page");
    } finally {
      versions.clearVersionStartsForTest();
      versions.setVersionDialForTest(async (p) => up.has(p));
    }
  });

  test("an idle link's versions expire with it", async () => {
    const { token } = plinks.mintOwnerLink(org.id, alp.id, Date.now() - 6 * DAY);
    const a = owner.ownerAccess(token);
    assert.ok(a.ok);
    const [current] = await versions.projectVersions(org.id, proj);
    await versions.openVersion(current!, a.link);
    const p = listPreviews({ projectId: proj.id }).find((x) => keptPreviews()[x.id]?.owner === a.link.hash)!;
    assert.ok(Math.abs(Date.parse(p.expiresAt) - Date.parse(a.link.expiresAt)) < 2000);
  });
});

describe("a version is its copy, not its label (§app.project-assistant/versions)", () => {
  const twin = join(root, "site-twin");
  mkdirSync(join(twin, ".sova"), { recursive: true });
  writeFileSync(join(twin, ".sova", "project.json"), JSON.stringify(DEF));
  const withTwin = () =>
    writeFileSync(
      registryFile(),
      JSON.stringify({
        version: 1,
        instances: [inst("i_main", site, 0, "2026-10-01T00:00:00.000Z", null), inst("i_other", otherTree, 2, "2026-10-12T00:00:00.000Z", "sova/a"), inst("i_twin", twin, 3, "2026-10-12T09:00:00.000Z", "sova/b")],
        shared: [],
      }),
    );
  const trees = async () => [
    { sessionId: "s_other", branch: "sova/a", path: otherTree, title: "x", sessionPath: null },
    { sessionId: "s_twin", branch: "sova/b", path: twin, title: "y", sessionPath: null },
  ];

  test("two team sessions started the same day get distinct labels; a copy of one running leaves the other's request open", async () => {
    withTwin();
    versions.setVersionTreesForTest(trees);
    up = new Set([23_000]);
    try {
      const vs = await versions.projectVersions(org.id, proj);
      assert.deepEqual(vs.map((v) => v.label), ["Current version", "Work in progress · started Oct 12", "Work in progress · started Oct 12 (2)"]);
      assert.deepEqual(vs.map((v) => v.legacyLabel ?? null), [null, "Fix 1 · started Oct 12", "Fix 2 · started Oct 12"]);
      const a = store.fileRequest(org.id, { projectId: proj.id, kind: "try", title: vs[1]!.label, text: "x", version: "i_other" });
      const b = store.fileRequest(org.id, { projectId: proj.id, kind: "try", title: vs[2]!.label, text: "x", version: "i_twin" });
      up = new Set([23_000, 23_003]);
      await versions.projectVersions(org.id, proj);
      assert.deepEqual([store.findRequest(org.id, a.id)?.status, store.findRequest(org.id, b.id)?.status], ["with-team", "done"], "only the copy that runs closes its own request");
    } finally {
      up = new Set([23_000, 23_001, 23_002]);
    }
  });

  test("an open request filed under an old label (no copy named) still closes once its copy runs; a closed one is never touched", async () => {
    withTwin();
    versions.setVersionTreesForTest(trees);
    up = new Set([23_000]);
    try {
      const old = store.fileRequest(org.id, { projectId: proj.id, kind: "try", title: "Fix 2 · started Oct 12", text: "filed before labels changed" });
      const closed = store.fileRequest(org.id, { projectId: proj.id, kind: "try", title: "Fix 2 · started Oct 12", text: "closed by the owner" });
      store.closeRequestLine(org.id, closed.id, { kind: "owner", personId: alp.id });
      up = new Set([23_000, 23_003]);
      await versions.projectVersions(org.id, proj);
      assert.equal(store.findRequest(org.id, old.id)?.status, "done");
      assert.equal(store.findRequest(org.id, closed.id)?.status, "closed");
    } finally {
      up = new Set([23_000, 23_001, 23_002]);
    }
  });

  test("start_version's pick: a label, an old label or a unique short name; several ask which", async () => {
    const { pickVersion } = await import("./project-assistant-tools");
    const vs = [{ label: "Current version" }, { label: "Work in progress · started Oct 12", legacyLabel: "Fix 1 · started Oct 12" }, { label: "Work in progress · started Oct 12 (2)", legacyLabel: "Fix 2 · started Oct 12" }, { label: "Fix: The bow page is slow" }];
    assert.equal(pickVersion(vs, "current").label, "Current version");
    assert.equal(pickVersion(vs, "Fix 1").label, "Work in progress · started Oct 12");
    assert.equal(pickVersion(vs, "fix 2 · started oct 12").label, "Work in progress · started Oct 12 (2)");
    assert.equal(pickVersion(vs, "Work in progress · started Oct 12").label, "Work in progress · started Oct 12", "an exact label wins over a longer one it starts");
    assert.equal(pickVersion(vs, "Fix: the bow").label, "Fix: The bow page is slow");
    assert.throws(() => pickVersion(vs, "Fix"), /Say which version: one of "Work in progress · started Oct 12", "Work in progress · started Oct 12 \(2\)", "Fix: The bow page is slow"\./);
    assert.throws(() => pickVersion(vs, "the purple one"), /Say which version: one of "Current version"/);
  });
});
