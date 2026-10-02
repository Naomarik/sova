// Run: pnpm exec tsx --test server/projects/routes.test.ts. Registration through the routes: a file:// clone
// (§app.projects/clone) and the folder path it hands to (§app.projects/registration). A throwaway
// PI_CODING_AGENT_DIR and repos in the OS temp dir; no network, ~/.pi is never read or written.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { Hono } from "hono";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "sova-project-routes-")));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
const agentDir = join(tmp, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
symlinkSync(resolve(import.meta.dirname, "..", "..", "pi-config", "extensions"), join(agentDir, "extensions"));

const { registerProjectRoutes } = await import("./routes");
const { readRegistry } = await import("./registry");
const { closeAllOrgHosts } = await import("../org-engine");
const { RELAYED_HEADER } = await import("../mesh/proxy");
after(() => closeAllOrgHosts());

const app = new Hono();
registerProjectRoutes(app);
const post = (body: unknown, headers: Record<string, string> = {}) => app.request("/api/projects", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString();
function sourceRepo(name: string): string {
  const dir = join(tmp, "src", name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(dir, "add", "README.md");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  return dir;
}
const parent = join(tmp, "code");
mkdirSync(parent);

test("POST /api/projects {clone} clones a file:// repo into a new folder and registers it standalone", async () => {
  const src = sourceRepo("widget");
  const res = await post({ clone: { repo: `file://${src}`, parent } });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { project: { id: string; name: string; root: string; origin: string; remote?: string; space: { kind: string } }; normalizedFrom?: string };
  assert.match(body.project.id, /^prj_[a-z0-9]{8}$/);
  assert.equal(body.project.root, join(parent, "widget"));
  assert.equal(body.project.name, "widget");
  assert.equal(body.project.origin, "clone");
  assert.equal(body.project.remote, `file://${src}`);
  assert.deepEqual(body.project.space, { kind: "standalone" });
  assert.equal(body.normalizedFrom, undefined);
  assert.equal(readFileSync(join(parent, "widget", "README.md"), "utf8"), "hello\n");
  assert.deepEqual(readRegistry().map((e) => e.id), [body.project.id]);
  const list = (await (await app.request("/api/projects")).json()) as { projects: { id: string }[] };
  assert.ok(list.projects.some((p) => p.id === body.project.id));

  // The same root again, as a folder: one project per checkout root.
  const again = await post({ root: join(parent, "widget") });
  assert.equal(again.status, 409);
  assert.equal(((await again.json()) as { error: string }).error, `${join(parent, "widget")} is already the project widget.`);
});

test("a clone into a folder that exists is refused before git runs; nothing is registered", async () => {
  const src = sourceRepo("taken");
  mkdirSync(join(parent, "taken"));
  writeFileSync(join(parent, "taken", "mine.txt"), "mine");
  const before = readRegistry();
  const res = await post({ clone: { repo: `file://${src}`, parent } });
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { error: string }).error, `${join(parent, "taken")} already exists.`);
  assert.deepEqual(readdirSync(join(parent, "taken")), ["mine.txt"]);
  assert.deepEqual(readRegistry(), before);
});

test("a failed clone answers git's reason, deletes only its own folder and registers nothing", async () => {
  const before = readRegistry();
  const siblings = readdirSync(parent).sort();
  const res = await post({ clone: { repo: `file://${join(tmp, "src", "missing")}`, parent, folder: "gone" } });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /^git clone failed/);
  assert.deepEqual(readdirSync(parent).sort(), siblings);
  assert.deepEqual(readRegistry(), before);
});

test("a clone relayed from a peer is refused: main listener only", async () => {
  const src = sourceRepo("relayed");
  const res = await post({ clone: { repo: `file://${src}`, parent } }, { [RELAYED_HEADER]: "peer" });
  assert.equal(res.status, 403);
  assert.ok(!readdirSync(parent).includes("relayed"));
});
