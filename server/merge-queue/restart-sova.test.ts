// Sova's own merge-thread script (.sova/playbooks/merge-queue/scripts/restart-sova.mjs): what the live server owes
// after landings, read from Git with the landed tree's own rule (server/restart-paths.ts). In-process, Git only:
// `--live` stands in for the server's health answer.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { scratchRoot } from "../test-scratch";
// @ts-expect-error: a plain .mjs script of Sova's own playbook, typed by use here
import { plan } from "../../.sova/playbooks/merge-queue/scripts/restart-sova.mjs";

type Plan = { action: string; install: boolean; restart: string[]; build: string[]; why: string };
const REPO = join(import.meta.dirname, "..", "..");

function repo() {
  const dir = scratchRoot("restart-sova-");
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "master");
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "t");
  const put = (files: Record<string, string>, msg: string) => {
    for (const [f, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), text);
    }
    git("add", "-A");
    git("commit", "-q", "-m", msg);
    return git("rev-parse", "HEAD");
  };
  mkdirSync(join(dir, "server"), { recursive: true });
  copyFileSync(join(REPO, "server", "restart-paths.ts"), join(dir, "server", "restart-paths.ts"));
  const first = put({ "README.md": "x\n" }, "first");
  return { dir, git, put, first };
}

test("plan: the landed files since the live commit decide: nothing, a page build, a restart (with the install it needs)", async () => {
  const r = repo();
  const at = (live: string) => plan({ repo: r.dir, live, target: "master" }) as Promise<Plan>;
  assert.equal((await at(r.first)).action, "nothing", "the live server runs the tip");
  const docs = r.put({ "docs/a.md": "a\n", "server/x.test.ts": "t\n" }, "docs and tests");
  assert.equal((await at(r.first)).action, "nothing");
  r.put({ "src/app.tsx": "app\n" }, "page");
  const page = await at(r.first);
  assert.deepEqual([page.action, page.build, page.install], ["build", ["src/app.tsx"], false]);
  r.put({ "src/lib/message.ts": "m\n" }, "a src file the server imports");
  const imported = await at(r.first);
  assert.deepEqual([imported.action, imported.restart], ["restart", ["src/lib/message.ts"]]);
  assert.equal(imported.install, false);
  assert.equal((await at(docs)).action, "restart", "every landing since the live commit counts, not only the newest");
  const lock = r.put({ "pnpm-lock.yaml": "lock\n" }, "packages");
  const pkgs = await at(r.first);
  assert.equal(pkgs.install, true);
  assert.equal((await at(lock)).action, "nothing", "already live");
});

test("plan: unknown when the main checkout isn't on the target's tip; an unknown live commit owes a restart with an install", async () => {
  const r = repo();
  r.put({ "server/a.ts": "a\n" }, "server");
  r.git("checkout", "-q", "--detach", r.first);
  const off = (await plan({ repo: r.dir, live: r.first, target: "master" })) as Plan;
  assert.equal(off.action, "unknown");
  assert.match(off.why, /main checkout is at/);
  r.git("checkout", "-q", "master");
  const foreign = (await plan({ repo: r.dir, live: "f".repeat(40), target: "master" })) as Plan;
  assert.deepEqual([foreign.action, foreign.install], ["restart", true]);
});
