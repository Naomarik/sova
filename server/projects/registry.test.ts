// Registry (projects.json) and clone. A throwaway PI_CODING_AGENT_DIR and folders in the OS temp dir; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "sova-registry-")));
const agentDir = join(tmp, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
after(() => rmSync(tmp, { recursive: true, force: true }));

const { addRegistryEntry, markImporting, mintProjectId, prepareRegistration, projectDirOf, readRegistry, registryEntry, removeRegistryEntry, RegistryError } = await import("./registry");
const { cloneRepo, folderOfRepo, repoUrlOf } = await import("./clone");
const { clearProjectCache } = await import("../project-root");

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString();
function repo(name: string): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "hi\n");
  git(dir, "add", "README.md");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  return dir;
}
const none = { rootsInUse: () => [] };

test("a missing projects.json is an empty registry; entries are minted, written atomically and read back", () => {
  assert.deepEqual(readRegistry(), []);
  const e = addRegistryEntry();
  assert.match(e.id, /^prj_[a-z0-9]{8}$/);
  assert.equal(e.dir, projectDirOf(e.id));
  assert.ok(existsSync(e.dir));
  const file = JSON.parse(readFileSync(join(agentDir, "sova", "projects.json"), "utf8"));
  assert.deepEqual(file, { version: 1, projects: [e] });
  assert.deepEqual(registryEntry(e.id), e);
  assert.deepEqual(readdirSync(join(agentDir, "sova")).filter((n) => n.endsWith(".tmp")), []);
  removeRegistryEntry(e.id, { removeEmptyDir: true });
  assert.deepEqual(readRegistry(), []);
  assert.ok(!existsSync(e.dir));
});

test("minting skips registered ids and the ids of placed projects", () => {
  const e = addRegistryEntry();
  for (let i = 0; i < 200; i++) {
    const id = mintProjectId(["prj_aaaaaaaa"]);
    assert.notEqual(id, e.id);
    assert.notEqual(id, "prj_aaaaaaaa");
  }
  removeRegistryEntry(e.id);
});

test("an importing mark is written and cleared; a rollback keeps a dir that holds files", () => {
  const e = addRegistryEntry();
  markImporting(e.id, { org: "org_x", at: "2026-01-01T00:00:00.000Z" });
  assert.deepEqual(registryEntry(e.id)?.importing, { org: "org_x", at: "2026-01-01T00:00:00.000Z" });
  markImporting(e.id, null);
  assert.equal(registryEntry(e.id)?.importing, undefined);
  writeFileSync(join(e.dir, "keep.txt"), "x");
  removeRegistryEntry(e.id, { removeEmptyDir: true });
  assert.ok(existsSync(join(e.dir, "keep.txt")));
});

test("unknown shapes and duplicate ids in projects.json are skipped", () => {
  writeFileSync(join(agentDir, "sova", "projects.json"), JSON.stringify({ version: 1, projects: [{ id: "nope", dir: "/x" }, { id: "prj_bbbbbbbb", dir: "/b", registeredAt: "t" }, { id: "prj_bbbbbbbb", dir: "/c" }] }));
  assert.deepEqual(readRegistry(), [{ id: "prj_bbbbbbbb", dir: "/b", registeredAt: "t" }]);
  writeFileSync(join(agentDir, "sova", "projects.json"), JSON.stringify({ version: 1, projects: [] }));
});

test("registration normalizes to the checkout root and says so", async () => {
  const root = repo("app");
  mkdirSync(join(root, "src", "deep"), { recursive: true });
  clearProjectCache();
  const p = await prepareRegistration(join(root, "src", "deep"), none);
  assert.equal(p.root, root);
  assert.equal(p.name, "app");
  assert.equal(p.git, true);
  assert.equal(p.normalizedFrom, join(root, "src", "deep"));
  const same = await prepareRegistration(root, none);
  assert.equal(same.normalizedFrom, undefined);
  // A linked worktree is its main checkout.
  git(root, "worktree", "add", "-q", join(tmp, "app-wt"), "-b", "wt");
  assert.equal((await prepareRegistration(join(tmp, "app-wt"), none)).root, root);
  // A plain folder is its own root.
  const plain = join(tmp, "plain");
  mkdirSync(plain);
  assert.deepEqual(await prepareRegistration(plain, none), { root: plain, name: "plain", git: false });
});

test("registration refuses a root already registered, reserved roots, and what isn't a local folder", async () => {
  const root = repo("taken");
  clearProjectCache();
  await assert.rejects(prepareRegistration(join(root, "."), { rootsInUse: () => [{ id: "prj_cccccccc", name: "Taken", root }] }), (e: InstanceType<typeof RegistryError>) => e.status === 409 && /is already the project Taken\./.test(e.message));
  await assert.rejects(prepareRegistration(join(agentDir, "sova"), none), /Sova's own state can't be a project\./);
  mkdirSync(join(agentDir, "sova", "projects", "x"), { recursive: true });
  await assert.rejects(prepareRegistration(join(agentDir, "sova", "projects", "x"), none), /Sova's own state can't be a project\./);
  const ws = join(tmp, "workspaces", "acme");
  mkdirSync(ws, { recursive: true });
  await assert.rejects(prepareRegistration(ws, { ...none, reservedRoots: () => [ws] }), /is inside .*Sova keeps for itself, so it can't be a project\./);
  await assert.rejects(prepareRegistration(join(tmp, "workspaces"), { ...none, reservedRoots: () => [ws] }), /holds .*Sova keeps for itself/);
  await assert.rejects(prepareRegistration("relative/path", none), /absolute/);
  await assert.rejects(prepareRegistration(join(tmp, "missing"), none), /doesn't exist/);
  await assert.rejects(prepareRegistration("", none), /folder path/);
});

test("a folder inside Sova's state or a reserved folder is refused even when it normalizes to a checkout outside it", async () => {
  // Sova's state inside a git checkout (a hermetic agent dir in a worktree): the checkout root is fine, the state isn't.
  const checkout = repo("holds-state");
  const state = join(checkout, "tmp", "agent", "sova");
  mkdirSync(state, { recursive: true });
  const saved = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(checkout, "tmp", "agent");
  try {
    clearProjectCache();
    await assert.rejects(prepareRegistration(join(checkout, "tmp", "agent"), none), /Sova's own state can't be a project\./);
    await assert.rejects(prepareRegistration(state, none), /Sova's own state can't be a project\./);
  } finally {
    process.env.PI_CODING_AGENT_DIR = saved;
  }
  const ws = join(checkout, "workspaces", "acme");
  mkdirSync(ws, { recursive: true });
  clearProjectCache();
  await assert.rejects(prepareRegistration(ws, { ...none, reservedRoots: () => [ws] }), /is inside .*Sova keeps for itself/);
});

test("folderOfRepo names the clone after the repository", () => {
  assert.equal(folderOfRepo("https://github.com/acme/widget.git"), "widget");
  assert.equal(folderOfRepo("git@github.com:acme/widget.git"), "widget");
  assert.equal(folderOfRepo("file:///tmp/src/widget/"), "widget");
});

test("GitHub's owner/name is its https URL; URLs stay as they are", () => {
  assert.equal(repoUrlOf("acme/widget"), "https://github.com/acme/widget.git");
  assert.equal(repoUrlOf("acme/widget.git"), "https://github.com/acme/widget.git");
  assert.equal(repoUrlOf("https://gitlab.com/a/b.git"), "https://gitlab.com/a/b.git");
  assert.equal(repoUrlOf("git@github.com:a/b.git"), "git@github.com:a/b.git");
});

test("clone: a file:// repo lands in a new folder under the parent", async () => {
  const src = repo("clone-src");
  const parent = join(tmp, "clones");
  mkdirSync(parent);
  const { dir } = await cloneRepo({ repo: `file://${src}`, parent });
  assert.equal(dir, join(parent, "clone-src"));
  assert.equal(readFileSync(join(dir, "README.md"), "utf8"), "hi\n");
  const named = await cloneRepo({ repo: `file://${src}`, parent, folder: "other" });
  assert.equal(named.dir, join(parent, "other"));
});

test("clone refuses an existing destination and leaves it alone", async () => {
  const src = repo("clone-src2");
  const parent = join(tmp, "clones2");
  mkdirSync(join(parent, "clone-src2"), { recursive: true });
  writeFileSync(join(parent, "clone-src2", "mine.txt"), "mine");
  await assert.rejects(cloneRepo({ repo: `file://${src}`, parent }), (e: InstanceType<typeof RegistryError>) => e.status === 409 && e.message === `${join(parent, "clone-src2")} already exists.`);
  assert.equal(readFileSync(join(parent, "clone-src2", "mine.txt"), "utf8"), "mine");
});

test("a failed clone deletes only the folder it created", async () => {
  const parent = join(tmp, "clones3");
  mkdirSync(parent);
  writeFileSync(join(parent, "sibling.txt"), "keep");
  await assert.rejects(cloneRepo({ repo: `file://${join(tmp, "no-such-repo")}`, parent, folder: "gone" }), /git clone failed/);
  assert.deepEqual(readdirSync(parent), ["sibling.txt"]);
});

test("clone refuses option-like URLs, bad folders and a relative parent before running git", async () => {
  const parent = join(tmp, "clones4");
  mkdirSync(parent);
  await assert.rejects(cloneRepo({ repo: "--upload-pack=touch /tmp/x", parent }), /repository URL/);
  await assert.rejects(cloneRepo({ repo: "/local/path", parent }), /repository URL/);
  await assert.rejects(cloneRepo({ repo: "https://github.com/a/b", parent, folder: "../escape" }), /plain folder name/);
  await assert.rejects(cloneRepo({ repo: "https://github.com/a/b", parent: "rel" }), /absolute/);
  assert.deepEqual(readdirSync(parent), []);
});
