import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ownCodeOf } from "../harness/pi/own-code";
import { buildId, codeRoot, collectGenerations, currentGeneration, generationDir, generationHealth, lastGood, noteGood, resetGenerations, startGenerationGc } from "./generations";
import { chatsRoot, scrubChatProcessEnv } from "./supervisor";

const quiet = () => {};
const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
  const e = { ...process.env };
  delete e.SOVA_BUILD;
  delete e.SOVA_CHAT_CODE;
  return { ...e, ...extra };
};
const gitIn = (repo: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8" }).trim();

/** A small checkout: tracked code, an ignored file, a lockfile and a node_modules with a relative link. */
function checkout() {
  const base = mkdtempSync(join(tmpdir(), "gen-"));
  const repo = join(base, "repo");
  mkdirSync(join(repo, "server", "chat-runtime"), { recursive: true });
  mkdirSync(join(repo, "pi-config", "extensions", "x"), { recursive: true });
  writeFileSync(join(repo, "server", "chat-runtime", "main.ts"), "console.log('main')\n");
  writeFileSync(join(repo, "pi-config", "extensions", "x", "index.ts"), "export default () => {}\n");
  writeFileSync(join(repo, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(join(repo, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  writeFileSync(join(repo, ".gitignore"), "node_modules\n*.log\n");
  writeFileSync(join(repo, "noise.log"), "ignored\n");
  mkdirSync(join(repo, "node_modules", ".pnpm", "dep@1", "node_modules", "dep"), { recursive: true });
  writeFileSync(join(repo, "node_modules", ".pnpm", "dep@1", "node_modules", "dep", "index.js"), "module.exports = 1\n");
  symlinkSync(join(".pnpm", "dep@1", "node_modules", "dep"), join(repo, "node_modules", "dep"));
  gitIn(repo, "init", "-q");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "one");
  return { base, repo, root: join(base, "code"), head: gitIn(repo, "rev-parse", "HEAD") };
}

test("the id: SOVA_BUILD, else the commit when clean, else the commit and a digest that sees untracked files", async () => {
  const { base, repo, head } = checkout();
  try {
    assert.equal(await buildId(repo, { ...env(), SOVA_BUILD: "b-1" }), "b-1");
    assert.equal(await buildId(repo, env()), head);
    writeFileSync(join(repo, "server", "chat-runtime", "main.ts"), "console.log('changed')\n");
    const dirty = await buildId(repo, env());
    assert.match(dirty, new RegExp(`^${head}\\+[0-9a-f]{8}$`));
    writeFileSync(join(repo, "new.ts"), "export {}\n");
    const untracked = await buildId(repo, env());
    assert.notEqual(untracked, dirty, "an untracked file changes the id");
    writeFileSync(join(repo, "new.ts"), "export const x = 1\n");
    assert.notEqual(await buildId(repo, env()), untracked, "and so do its bytes");
    writeFileSync(join(repo, "more.log"), "ignored\n");
    assert.equal(await buildId(repo, env()), await buildId(repo, env()), "stable");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a generation: the code's files read-only, ignored ones left out, node_modules shared per lockfile; reused after", async () => {
  const { base, repo, root, head } = checkout();
  try {
    writeFileSync(join(repo, "untracked.ts"), "export {}\n");
    const gen = await currentGeneration({ repo, root, env: env(), log: quiet });
    assert.equal(gen.live, false);
    assert.equal(gen.dir, generationDir(gen.id, root));
    assert.match(gen.id, new RegExp(`^${head}\\+`));
    const main = join(gen.dir, "server", "chat-runtime", "main.ts");
    assert.equal(readFileSync(main, "utf8"), "console.log('main')\n");
    assert.equal(statSync(main).mode & 0o777, 0o444);
    assert.equal(statSync(join(gen.dir, "run.sh")).mode & 0o777, 0o555);
    assert.ok(existsSync(join(gen.dir, "untracked.ts")), "untracked, not ignored: copied");
    assert.ok(!existsSync(join(gen.dir, "noise.log")), "ignored: left out");
    assert.match(readlinkSync(join(gen.dir, "node_modules")), /^\.\.\/deps\/[0-9a-f]{16}\/node_modules$/);
    assert.equal(readFileSync(join(gen.dir, "node_modules", "dep", "index.js"), "utf8"), "module.exports = 1\n");
    assert.ok(realpathSync(join(gen.dir, "node_modules", "dep")).startsWith(realpathSync(root)), "the package resolves inside the copy");
    assert.deepEqual(generationHealth(), { code: "copy" });

    // The checkout changes: the copy doesn't.
    writeFileSync(join(repo, "untracked.ts"), "export const changed = 1\n");
    assert.equal(readFileSync(join(gen.dir, "untracked.ts"), "utf8"), "export {}\n");

    // Same code again: the same copy, not made again.
    writeFileSync(join(repo, "untracked.ts"), "export {}\n");
    const before = statSync(main).mtimeMs;
    const again = await currentGeneration({ repo, root, env: env(), log: quiet });
    assert.equal(again.dir, gen.dir);
    assert.equal(statSync(main).mtimeMs, before);
  } finally {
    rmSync(base, { recursive: true, force: true });
    resetGenerations();
  }
});

test("a half-made generation is made again; a reused one whose shared node_modules went gets them back", async () => {
  const { base, repo, root } = checkout();
  try {
    const gen = await currentGeneration({ repo, root, env: env(), log: quiet });
    rmSync(join(gen.dir, ".complete"));
    rmSync(join(gen.dir, "server"), { recursive: true });
    const again = await currentGeneration({ repo, root, env: env(), log: quiet });
    assert.equal(again.live, false);
    assert.ok(existsSync(join(again.dir, "server", "chat-runtime", "main.ts")));
    rmSync(join(root, "deps"), { recursive: true, force: true });
    await currentGeneration({ repo, root, env: env(), log: quiet });
    assert.ok(existsSync(join(again.dir, "node_modules", "dep", "index.js")));
  } finally {
    rmSync(base, { recursive: true, force: true });
    resetGenerations();
  }
});

test("no copy: the checkout itself, with the reason; SOVA_CHAT_CODE=live skips the copy", async () => {
  const { base, repo, root, head } = checkout();
  try {
    const lines: string[] = [];
    const sw = await currentGeneration({ repo, root, env: env({ SOVA_CHAT_CODE: "live" }), log: (l) => lines.push(l) });
    assert.deepEqual(sw, { id: head, dir: repo, live: true, why: "test switch" });
    assert.deepEqual(generationHealth(), { code: "live", codeWhy: "test switch" });
    assert.ok(!existsSync(root));

    rmSync(join(repo, "node_modules"), { recursive: true });
    const failed = await currentGeneration({ repo, root, env: env(), log: (l) => lines.push(l) });
    assert.equal(failed.live, true);
    assert.equal(failed.dir, repo);
    assert.equal(failed.id, head);
    assert.match(failed.why ?? "", /no node_modules/);
    assert.deepEqual(generationHealth(), { code: "live", codeWhy: "copy failed" });
    assert.ok(lines.some((l) => /from the checkout itself/.test(l)));
    assert.deepEqual(
      readdirNames(root).filter((n) => n.startsWith(".tmp-")),
      [],
      "nothing half-made is left",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
    resetGenerations();
  }
});

const readdirNames = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};
const age = (p: string, ms: number) => {
  const t = (Date.now() - ms) / 1000;
  utimesSync(p, t, t);
};

test("collection keeps what is in use, the last good one and young ones; removes the rest and unused node_modules", async () => {
  const { base, repo, root } = checkout();
  try {
    const run = (b: string) => currentGeneration({ repo, root, env: env({ SOVA_BUILD: b }), log: quiet });
    const a = await run("gen-a");
    const b = await run("gen-b");
    const c = await run("gen-c");
    const d = await run("gen-d");
    const lockDir = readlinkSync(join(a.dir, "node_modules")).split("/")[2]!;
    noteGood("gen-c", root);
    assert.equal(lastGood(root), "gen-c");
    for (const g of [a, b, c]) age(g.dir, 60 * 60_000);
    // d is young; a in use; c last good; b goes.
    assert.deepEqual(await collectGenerations(new Set(["gen-a"]), { root }), ["gen-b"]);
    assert.ok(existsSync(a.dir) && existsSync(c.dir) && existsSync(d.dir) && !existsSync(b.dir));
    assert.ok(existsSync(join(root, "deps", lockDir)), "node_modules still linked");

    // Nothing in use, nothing good, all old: everything goes, its node_modules too.
    rmSync(join(root, "good"));
    for (const g of [a, c, d]) age(g.dir, 60 * 60_000);
    age(join(root, "deps", lockDir), 60 * 60_000);
    const gone = await collectGenerations(new Set(), { root });
    assert.deepEqual(gone.sort(), ["deps/" + lockDir, "gen-a", "gen-c", "gen-d"].sort());
    assert.deepEqual(readdirNames(join(root, "deps")), []);
  } finally {
    rmSync(base, { recursive: true, force: true });
    resetGenerations();
  }
});

test("the collector: at once, keeping the current generation and what is in use; again on request", async () => {
  const { base, repo, root } = checkout();
  try {
    const old = await currentGeneration({ repo, root, env: env({ SOVA_BUILD: "gen-old" }), log: quiet });
    const used = await currentGeneration({ repo, root, env: env({ SOVA_BUILD: "gen-used" }), log: quiet });
    const cur = await currentGeneration({ repo, root, env: env({ SOVA_BUILD: "gen-cur" }), log: quiet });
    for (const g of [old, used, cur]) age(g.dir, 60 * 60_000);
    const lines: string[] = [];
    const gc = startGenerationGc(() => ["gen-used"], { root, log: (l) => lines.push(l) });
    await gc.collect();
    gc.stop();
    assert.ok(!existsSync(old.dir) && existsSync(used.dir) && existsSync(cur.dir));
    assert.deepEqual(lines, ["removed unused code: gen-old"]);
  } finally {
    rmSync(base, { recursive: true, force: true });
    resetGenerations();
  }
});

test("a server started from a chat's tools: once the chat's variables are deleted, its copies go under its own state root, never the chat's server's, and it maps nothing", () => {
  const server: NodeJS.ProcessEnv = { ...env(), SOVA_CHAT_LIVE_ROOT: "/live", SOVA_CHAT_COPIES_ROOT: "/live-state/chats/code", SOVA_CHAT_STATE_ROOT: "/live-state" };
  scrubChatProcessEnv(server);
  assert.equal(codeRoot(server), join(chatsRoot(), "code"));
  assert.equal(ownCodeOf(server, "/anywhere"), null);
});

test("no collection on a root set by SOVA_CHAT_CODE_ROOT, which other servers may share", async () => {
  const lines: string[] = [];
  const gc = startGenerationGc(() => [], { env: { SOVA_CHAT_CODE_ROOT: "/shared" }, log: (l) => lines.push(l) });
  await gc.collect();
  gc.stop();
  assert.match(lines.join("\n"), /not collected under SOVA_CHAT_CODE_ROOT \(\/shared\)/);
});

test("a build id that is no directory name is hashed", () => {
  assert.equal(generationDir("abc+12345678", "/r"), "/r/abc+12345678");
  assert.match(generationDir("../x", "/r"), /^\/r\/h-[0-9a-f]{16}$/);
  assert.match(generationDir("deps", "/r"), /^\/r\/h-/);
});
