// Run: pnpm exec tsx --test server/org-holder.test.ts. §app.organizations/holder: one host holds an
// org at a time; attaching an org another host holds warns and asks to confirm. The record lives in
// the org statechart's portable snapshot (r1). Real git: a bare remote and clones in the OS temp dir
// (deleted after); "laptop" is another host, its repo made by an engine of its own. A throwaway
// PI_CODING_AGENT_DIR; no model, no network.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-org-holder-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions"), { recursive: true });

const orgs = await import("./orgs");
const { hostIdentity, holderOfSnapshot, orgSnapshotPath } = await import("./org-holder");
const { OrgHost } = await import("./org-host");
const { settled } = await import("./workspace-git");

after(() => rmSync(root, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=T", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const LAPTOP = { hostId: "h_laptop00", hostName: "laptop" };
const SINCE = Date.parse("2026-09-27T10:00:00.000Z");

/** The holder the org snapshot in `dir` (or at `rev` of the repo) names. */
const holderIn = (dir: string, id: string, rev?: string) =>
  holderOfSnapshot(`org/${id}`, rev ? git(dir, "show", `${rev}:${orgSnapshotPath(id)}`) : git(dir, "show", `HEAD:${orgSnapshotPath(id)}`));

/** "laptop" holds org `id` (an engine of its own, in its own state dir) and pushes it to `remote`. */
async function laptopRepo(id: string, remote: string): Promise<{ dir: string; host: Awaited<ReturnType<typeof OrgHost.open>> }> {
  const dir = join(root, `laptop-${id}`);
  mkdirSync(join(dir, "sessions"), { recursive: true });
  git(root, "init", "-q", "-b", "main", dir);
  writeFileSync(join(dir, "sessions", ".gitkeep"), "");
  const host = await OrgHost.open({ orgId: id, workspaceDir: dir, stateDir: join(root, `laptop-state-${id}`), durable: false });
  await host.start(`org/${id}`, "org", { id, name: "Harbor", slug: "harbor", createdAt: SINCE }, { by: "operator" });
  await host.act(`org/${id}`, "holder/claim", { ...LAPTOP, since: SINCE }, { by: "system" });
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "laptop");
  git(dir, "remote", "add", "origin", remote);
  git(dir, "push", "-q", "origin", "main");
  return { dir, host };
}
async function laptopSays(l: { dir: string; host: Awaited<ReturnType<typeof OrgHost.open>> }, id: string, event: "holder/claim" | "holder/release", message: string): Promise<void> {
  await l.host.act(`org/${id}`, event, event === "holder/claim" ? { ...LAPTOP, since: SINCE + 7_200_000 } : { hostId: LAPTOP.hostId }, { by: "system" });
  git(l.dir, "add", "-A");
  git(l.dir, "commit", "-q", "-m", message);
  git(l.dir, "push", "-q", "origin", "main");
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

  test("creating an org records this host as its holder in the org's snapshot, in the first commit; no holder.json", async () => {
    const org = await orgs.createOrg({ name: "Mine", dir: join(root, "mine") });
    const dir = orgs.orgDir(org.id);
    await settled(dir);
    const h = holderIn(dir, org.id)!;
    assert.deepEqual([h.hostId, h.hostName], [hostIdentity().id, hostIdentity().name]);
    assert.ok(!git(dir, "ls-files").split("\n").includes("holder.json"));
    assert.match(git(dir, "log", "--format=%s"), /Create organization Mine/);
  });

  test("held by another host (the clone says so): refused with the holder named, nothing added; confirmed, this host holds it and pushes that", async () => {
    const remote = bare("r1");
    await laptopRepo("org_held0001", remote);
    const dir = clone(remote, "c1");
    const err = await orgs.attachOrg({ dir }).then(
      () => null,
      (e: InstanceType<typeof orgs.OrgError>) => e,
    );
    assert.ok(err instanceof orgs.OrgError, "refused");
    assert.equal(err.status, 409);
    assert.equal(err.code, "held");
    assert.equal(err.message, "laptop holds this organization (since 2026-09-27 10:00 UTC). If it still runs there, attaching it here too makes two copies that drift apart, and one host's work can't be pushed. Detach it on laptop first, or attach anyway if laptop is gone.");
    assert.equal(orgs.readIndex().orgs.some((o) => o.id === "org_held0001"), false, "nothing added");
    const org = await orgs.attachOrg({ dir, confirm: true });
    await settled(dir);
    assert.equal(org.id, "org_held0001");
    assert.equal(holderIn(dir, org.id)!.hostId, hostIdentity().id);
    assert.equal(git(dir, "status", "--porcelain"), "", "committed at once");
    assert.equal(holderIn(join(root, "r1.git"), org.id, "main")!.hostId, hostIdentity().id, "and pushed");
    assert.match(git(dir, "log", "-1", "--format=%s"), /^Attached on /);
  });

  test("detach releases it (committed and pushed): a clone attached after that asks nothing", async () => {
    await orgs.detachOrg("org_held0001");
    const dir = join(root, "c1");
    await settled(dir);
    const h = holderIn(dir, "org_held0001")!;
    assert.equal(h.releasedBy, hostIdentity().id);
    assert.match(git(dir, "log", "-1", "--format=%s"), /^Released by /);
    const again = clone(join(root, "r1.git"), "c1b");
    assert.equal((await orgs.attachOrg({ dir: again })).id, "org_held0001");
    await orgs.detachOrg("org_held0001");
  });

  test("the remote says another host holds it, though the clone says released: held", async () => {
    const remote = bare("r2");
    const lap = await laptopRepo("org_held0002", remote);
    await laptopSays(lap, "org_held0002", "holder/release", "released");
    const dir = clone(remote, "c2");
    // Laptop attaches it again after the clone was made.
    await laptopSays(lap, "org_held0002", "holder/claim", "attached again");
    await assert.rejects(orgs.attachOrg({ dir }), (e: unknown) => e instanceof orgs.OrgError && e.code === "held" && /^laptop holds this organization/.test(e.message));
  });

  test("a remote that can't be reached: the clone's record alone", async () => {
    const remote = bare("r3");
    const lap = await laptopRepo("org_held0003", remote);
    await laptopSays(lap, "org_held0003", "holder/release", "released");
    const dir = clone(remote, "c3");
    git(dir, "remote", "set-url", "origin", join(root, "nowhere.git"));
    assert.equal((await orgs.attachOrg({ dir })).id, "org_held0003");
    await orgs.detachOrg("org_held0003");
  });

  test("a dir with no org snapshot is not a workspace repo", async () => {
    const empty = join(root, "empty");
    mkdirSync(empty, { recursive: true });
    await assert.rejects(orgs.attachOrg({ dir: empty }), { message: "No organization in that dir: not a workspace repo." });
  });
});
