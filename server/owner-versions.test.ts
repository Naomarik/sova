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
  test("current first, a fix by its request's title, another by number and date; no branch, title or port", async () => {
    const vs = await versions.projectVersions(org.id, proj);
    assert.deepEqual(
      vs.map((v) => [v.label, v.running]),
      [
        ["Current version", true],
        ["Fix: The bow page is slow", true],
        ["Fix 1 · started Oct 12", true],
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
      assert.deepEqual(vs.map((v) => v.label), ["Fix: The bow page is slow", "Fix 1 · started Oct 12"]);
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
