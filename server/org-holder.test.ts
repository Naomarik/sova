// Run: pnpm exec tsx --test server/org-holder.test.ts. §app.organizations/holder: one host holds an
// org at a time; attaching an org another host holds warns and asks to confirm. Real git: a bare
// remote and clones in the OS temp dir (deleted after); "laptop" is another host, its repo made by
// hand. A throwaway PI_CODING_AGENT_DIR; no model, no network.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-org-holder-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions"), { recursive: true });

const orgs = await import("./orgs");
const { hostIdentity } = await import("./org-holder");
const { settled } = await import("./workspace-git");

after(() => rmSync(root, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=T", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const holderIn = (dir: string) => JSON.parse(readFileSync(join(dir, "holder.json"), "utf8"));
const LAPTOP = { id: "h_laptop00", name: "laptop" };

/** "laptop" holds org `id` and pushes it to `remote`. */
function laptopRepo(id: string, remote: string): string {
  const dir = join(root, `laptop-${id}`);
  mkdirSync(join(dir, "sessions"), { recursive: true });
  git(root, "init", "-q", "-b", "main", dir);
  writeFileSync(join(dir, "org.json"), JSON.stringify({ version: 1, id, name: "Harbor", slug: "harbor", createdAt: "2026-09-27T10:00:00.000Z" }));
  writeFileSync(join(dir, "roster.json"), JSON.stringify({ version: 1, people: [] }));
  writeFileSync(join(dir, "projects.json"), JSON.stringify({ version: 1, projects: [] }));
  writeFileSync(join(dir, "sessions", ".gitkeep"), "");
  writeFileSync(join(dir, "holder.json"), JSON.stringify({ version: 1, host: LAPTOP, since: "2026-09-27T10:00:00.000Z" }));
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "laptop");
  git(dir, "remote", "add", "origin", remote);
  git(dir, "push", "-q", "origin", "main");
  return dir;
}
const bare = (name: string) => {
  const dir = join(root, `${name}.git`);
  git(root, "init", "-q", "--bare", "-b", "main", dir);
  return dir;
};
const clone = (remote: string, name: string) => {
  const dir = join(root, name);
  git(root, "clone", "-q", remote, dir);
  return dir;
};

describe("one holder at a time", () => {
  test("this host's identity: made once, kept", () => {
    const me = hostIdentity();
    assert.match(me.id, /^h_[a-z0-9]{8}$/);
    assert.ok(me.name);
    assert.deepEqual(hostIdentity(), me);
  });

  test("creating an org records this host as its holder, in the first commit", async () => {
    const org = await orgs.createOrg({ name: "Mine", dir: join(root, "mine") });
    const dir = orgs.orgDir(org.id);
    assert.deepEqual(holderIn(dir).host, hostIdentity());
    assert.ok(git(dir, "ls-files").split("\n").includes("holder.json"));
  });

  test("held by another host (the clone says so): refused with the holder named, nothing added; confirmed, this host holds it and pushes that", async () => {
    const remote = bare("r1");
    laptopRepo("org_held0001", remote);
    const dir = clone(remote, "c1");
    const err = await orgs.attachOrg({ dir }).then(
      () => null,
      (e: InstanceType<typeof orgs.OrgError>) => e,
    );
    assert.ok(err instanceof orgs.OrgError, "refused");
    assert.equal(err.status, 409);
    assert.equal(err.code, "held");
    assert.match(err.message, /^laptop holds this organization \(since .+\)\. If it still runs there, attaching it here too makes two copies that drift apart, and one host's work can't be pushed\. Detach it on laptop first, or attach anyway if laptop is gone\.$/);
    assert.equal(orgs.readIndex().orgs.some((o) => o.id === "org_held0001"), false, "nothing added");
    const org = await orgs.attachOrg({ dir, confirm: true });
    await settled(dir);
    assert.equal(org.id, "org_held0001");
    assert.deepEqual(holderIn(dir).host, hostIdentity());
    assert.equal(git(dir, "status", "--porcelain"), "", "committed at once");
    assert.deepEqual(JSON.parse(git(root, "--git-dir", remote, "show", "main:holder.json")).host, hostIdentity(), "and pushed");
  });

  test("detach releases it (committed and pushed): a clone attached after that asks nothing", async () => {
    await orgs.detachOrg("org_held0001");
    const dir = join(root, "c1");
    assert.equal(holderIn(dir).host, null);
    assert.deepEqual(holderIn(dir).releasedBy, hostIdentity());
    const again = clone(join(root, "r1.git"), "c1b");
    assert.equal((await orgs.attachOrg({ dir: again })).id, "org_held0001");
    await orgs.detachOrg("org_held0001");
  });

  test("the remote says another host holds it, though the clone says released: held", async () => {
    const remote = bare("r2");
    const lap = laptopRepo("org_held0002", remote);
    writeFileSync(join(lap, "holder.json"), JSON.stringify({ version: 1, host: null, releasedBy: LAPTOP, at: "2026-09-27T11:00:00.000Z" }));
    git(lap, "commit", "-q", "-am", "released");
    git(lap, "push", "-q", "origin", "main");
    const dir = clone(remote, "c2");
    // Laptop attaches it again after the clone was made.
    writeFileSync(join(lap, "holder.json"), JSON.stringify({ version: 1, host: LAPTOP, since: "2026-09-27T12:00:00.000Z" }));
    git(lap, "commit", "-q", "-am", "attached again");
    git(lap, "push", "-q", "origin", "main");
    await assert.rejects(orgs.attachOrg({ dir }), (e: unknown) => e instanceof orgs.OrgError && e.code === "held" && /^laptop holds this organization/.test(e.message));
  });

  test("a remote that can't be reached: the clone's record alone; a repo with no record is held by nobody", async () => {
    const remote = bare("r3");
    const lap = laptopRepo("org_held0003", remote);
    writeFileSync(join(lap, "holder.json"), JSON.stringify({ version: 1, host: null, releasedBy: LAPTOP, at: "2026-09-27T11:00:00.000Z" }));
    git(lap, "commit", "-q", "-am", "released");
    git(lap, "push", "-q", "origin", "main");
    const dir = clone(remote, "c3");
    git(dir, "remote", "set-url", "origin", join(root, "nowhere.git"));
    assert.equal((await orgs.attachOrg({ dir })).id, "org_held0003");
    await orgs.detachOrg("org_held0003");
    const old = clone(bare("r4"), "c4");
    writeFileSync(join(old, "org.json"), JSON.stringify({ version: 1, id: "org_held0004", name: "Old", slug: "old", createdAt: "2026-09-27T10:00:00.000Z" }));
    writeFileSync(join(old, "roster.json"), JSON.stringify({ version: 1, people: [] }));
    writeFileSync(join(old, "projects.json"), JSON.stringify({ version: 1, projects: [] }));
    assert.equal((await orgs.attachOrg({ dir: old })).id, "org_held0004", "made before the record existed");
    await orgs.detachOrg("org_held0004");
  });
});
