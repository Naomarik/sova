import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ownCodeOf } from "../harness/pi/own-code";
import { buildId, codeRoot, isGenerationComplete, scanProcesses, collectGenerations, currentGeneration, generationDir, generationHealth, lastGood, noteGood, resetGenerations, startGenerationGc } from "./generations";
import { chatsRoot, scrubChatProcessEnv } from "./supervisor";

const quiet = () => {};
/** No process runs from any copy (the process-table seam). */
const none = async () => ({ commands: [] as string[], cwds: [] as string[] });
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

test("a deployed tree with no Git (stamped with BUILD_COMMIT): copied whole but for node_modules, the deploy's own artifacts and the agent dir inside it", async () => {
  const base = mkdtempSync(join(tmpdir(), "gen-"));
  const repo = join(base, "app");
  const stamp = "0123456789abcdef0123456789abcdef01234567";
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    mkdirSync(join(repo, "server", "chat-runtime"), { recursive: true });
    writeFileSync(join(repo, "server", "chat-runtime", "main.ts"), "console.log('main')\n");
    mkdirSync(join(repo, ".sova", "spec"), { recursive: true });
    writeFileSync(join(repo, ".sova", "spec", "manifest.json"), "{}\n");
    writeFileSync(join(repo, "BUILD_COMMIT"), `${JSON.stringify({ commit: stamp })}\n`);
    writeFileSync(join(repo, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    mkdirSync(join(repo, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(repo, "node_modules", "dep", "index.js"), "module.exports = 1\n");
    mkdirSync(join(repo, "pi-config", "extensions", "x", "node_modules", "y"), { recursive: true });
    writeFileSync(join(repo, "pi-config", "extensions", "x", "index.ts"), "export default () => {}\n");
    writeFileSync(join(repo, "pi-config", "extensions", "x", "node_modules", "y", "index.js"), "\n");
    for (const d of [".bun/bin", ".accept", "dist", "dist-share"]) {
      mkdirSync(join(repo, d), { recursive: true });
      writeFileSync(join(repo, d, "f"), "deploy\n");
    }
    // The lab's layout: the agent dir inside the tree, the copies under its state root.
    process.env.PI_CODING_AGENT_DIR = join(repo, ".agent");
    mkdirSync(join(repo, ".agent", "sessions"), { recursive: true });
    writeFileSync(join(repo, ".agent", "auth.json"), "{}\n");
    const root = join(repo, ".agent", "sova", "chats", "code");
    const gen = await currentGeneration({ repo, root, env: env(), log: quiet });
    assert.equal(gen.live, false, gen.why);
    assert.equal(gen.id, stamp);
    assert.equal(readFileSync(join(gen.dir, "server", "chat-runtime", "main.ts"), "utf8"), "console.log('main')\n");
    assert.ok(existsSync(join(gen.dir, ".sova", "spec", "manifest.json")), "a tracked dot-dir is code");
    assert.ok(existsSync(join(gen.dir, "BUILD_COMMIT")));
    assert.ok(existsSync(join(gen.dir, "pi-config", "extensions", "x", "index.ts")));
    for (const gone of [".agent", ".bun", ".accept", "dist", "dist-share", "pi-config/extensions/x/node_modules"]) assert.ok(!existsSync(join(gen.dir, gone)), gone);
    assert.match(readlinkSync(join(gen.dir, "node_modules")), /^\.\.\/deps\/[0-9a-f]{16}\/node_modules$/);
    assert.equal(readFileSync(join(gen.dir, "node_modules", "dep", "index.js"), "utf8"), "module.exports = 1\n");
    assert.deepEqual(generationHealth(), { code: "copy" });
  } finally {
    if (agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = agentDir;
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
/** Make a copy (or a deps snapshot) look `ms` old: its directory and its `.complete` marker. */
const age = (p: string, ms: number) => {
  const t = (Date.now() - ms) / 1000;
  utimesSync(p, t, t);
  if (existsSync(join(p, ".complete"))) utimesSync(join(p, ".complete"), t, t);
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
    const gc = startGenerationGc(() => ["gen-used"], { scan: none, root, log: (l) => lines.push(l) });
    await gc.collect();
    gc.stop();
    assert.ok(!existsSync(old.dir) && existsSync(used.dir) && existsSync(cur.dir));
    assert.deepEqual(lines.filter((l) => l.startsWith("removed")), ["removed unused code: gen-old"]);
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

test("a copy's age is its marker's: a file a chat process writes in its working directory (the copy) doesn't keep it; what is kept, and why, is logged", async () => {
  const { base, repo, root } = checkout();
  try {
    const old = await currentGeneration({ repo, root, env: env({ SOVA_BUILD: "gen-old" }), log: quiet });
    const used = await currentGeneration({ repo, root, env: env({ SOVA_BUILD: "gen-used" }), log: quiet });
    await currentGeneration({ repo, root, env: env({ SOVA_BUILD: "gen-cur" }), log: quiet });
    for (const g of [old, used]) age(g.dir, 60 * 60_000);
    writeFileSync(join(old.dir, "stray.log"), "written by a chat process\n"); // the directory is new again
    const lines: string[] = [];
    const gc = startGenerationGc(() => ["gen-used"], { scan: none, root, log: (l) => lines.push(l) });
    await gc.collect();
    gc.stop();
    assert.ok(!existsSync(old.dir), "its marker is old: collected");
    assert.ok(lines.includes("removed unused code: gen-old"), lines.join("\n"));
    assert.ok(lines.includes("kept older code: gen-used (in use)"), lines.join("\n"));
  } finally {
    rmSync(base, { recursive: true, force: true });
    resetGenerations();
  }
});

test("SOVA_CHAT_CODE_GRACE_MIN shortens the grace (trials)", async () => {
  const { base, repo, root } = checkout();
  try {
    const old = await currentGeneration({ repo, root, env: env({ SOVA_BUILD: "gen-old" }), log: quiet });
    await currentGeneration({ repo, root, env: env({ SOVA_BUILD: "gen-cur" }), log: quiet });
    age(old.dir, 2_000);
    const keep = startGenerationGc(() => [], { scan: none, root, env: { SOVA_CHAT_CODE_GRACE_MIN: "1" }, log: quiet });
    await keep.collect();
    keep.stop();
    assert.ok(existsSync(old.dir), "2 s old, under 1 min: kept");
    const gc = startGenerationGc(() => [], { scan: none, root, env: { SOVA_CHAT_CODE_GRACE_MIN: "0.01" }, log: quiet });
    await gc.collect();
    gc.stop();
    assert.ok(!existsSync(old.dir), "over 0.6 s: gone");
  } finally {
    rmSync(base, { recursive: true, force: true });
    resetGenerations();
  }
});

test("no collection on a root set by SOVA_CHAT_CODE_ROOT, which other servers may share", async () => {
  const lines: string[] = [];
  const gc = startGenerationGc(() => [], { scan: none, env: { SOVA_CHAT_CODE_ROOT: "/shared" }, log: (l) => lines.push(l) });
  await gc.collect();
  gc.stop();
  assert.match(lines.join("\n"), /not collected under SOVA_CHAT_CODE_ROOT \(\/shared\)/);
});

test("SOVA_CHAT_CODE_GC=on: a root set by SOVA_CHAT_CODE_ROOT that is this server's alone is collected", async () => {
  const { base, repo, root } = checkout();
  try {
    const old = await currentGeneration({ repo, root, env: env({ SOVA_BUILD: "gen-old" }), log: quiet });
    await currentGeneration({ repo, root, env: env({ SOVA_BUILD: "gen-cur" }), log: quiet });
    age(old.dir, 60 * 60_000);
    const gc = startGenerationGc(() => [], { scan: none, env: { SOVA_CHAT_CODE_ROOT: root, SOVA_CHAT_CODE_GC: "on" }, log: quiet });
    await gc.collect();
    gc.stop();
    assert.ok(!existsSync(old.dir));
  } finally {
    rmSync(base, { recursive: true, force: true });
    resetGenerations();
  }
});

test("hardlinks refused across filesystems (EXDEV): node_modules copied in full, said once in the log and in health, never a fallback to the checkout", async () => {
  const { base, repo, root } = checkout();
  try {
    const lines: string[] = [];
    let tries = 0;
    const exdev = async () => {
      tries++;
      throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
    };
    const gen = await currentGeneration({ repo, root, env: env(), log: (l) => lines.push(l), link: exdev });
    assert.equal(gen.live, false);
    assert.equal(tries, 1, "tried once, then copies");
    assert.equal(readFileSync(join(gen.dir, "node_modules", "dep", "index.js"), "utf8"), "module.exports = 1\n");
    assert.deepEqual(lines.filter((l) => /another filesystem/.test(l)), ["copies root on another filesystem: full node_modules copy, 0 MB"]);
    assert.deepEqual(generationHealth(), { code: "copy", codeWhy: "full node_modules copy (another filesystem)" });
    // Reused: the snapshot says how it was made; nothing copied or logged again.
    lines.length = 0;
    await currentGeneration({ repo, root, env: env(), log: (l) => lines.push(l), link: exdev });
    assert.equal(tries, 1);
    assert.deepEqual(lines.filter((l) => /another filesystem/.test(l)), []);
    assert.deepEqual(generationHealth(), { code: "copy", codeWhy: "full node_modules copy (another filesystem)" });
  } finally {
    rmSync(base, { recursive: true, force: true });
    resetGenerations();
  }
});

test("a copies root inside the checkout's node_modules is never copied into itself", async () => {
  const { base, repo } = checkout();
  try {
    const root = join(repo, "node_modules", ".cache", "sova-chat-code-t");
    const gen = await currentGeneration({ repo, root, env: env(), log: quiet });
    assert.equal(gen.live, false);
    const deps = readlinkSync(join(gen.dir, "node_modules")).split("/")[2]!;
    assert.ok(existsSync(join(root, "deps", deps, "node_modules", "dep", "index.js")));
    assert.ok(!existsSync(join(root, "deps", deps, "node_modules", ".cache", "sova-chat-code-t")), "the root left out of its own snapshot");
  } finally {
    rmSync(base, { recursive: true, force: true });
    resetGenerations();
  }
});

test("isGenerationComplete: a finished copy with its node_modules; not a half-made one, one whose node_modules went, or one never made", async () => {
  const { base, repo, root } = checkout();
  try {
    const gen = await currentGeneration({ repo, root, env: env({ SOVA_BUILD: "gen-a" }), log: quiet });
    assert.equal(isGenerationComplete("gen-a", root), true);
    assert.equal(isGenerationComplete("gen-none", root), false);
    const deps = readlinkSync(join(gen.dir, "node_modules")).split("/")[2]!;
    rmSync(join(root, "deps", deps, ".complete"));
    assert.equal(isGenerationComplete("gen-a", root), false, "its node_modules unfinished or gone");
    rmSync(join(gen.dir, ".complete"));
    assert.equal(isGenerationComplete("gen-a", root), false, "half-made");
  } finally {
    rmSync(base, { recursive: true, force: true });
    resetGenerations();
  }
});

test("a copy a running process uses is kept, whatever the records say: by its command line (any path in the copy), or its working folder; another root's copies change nothing", async () => {
  const { base, repo, root } = checkout();
  try {
    const old = await currentGeneration({ repo, root, env: env({ SOVA_BUILD: "gen-a" }), log: quiet });
    const helper = await currentGeneration({ repo, root, env: env({ SOVA_BUILD: "gen-h" }), log: quiet });
    const wd = await currentGeneration({ repo, root, env: env({ SOVA_BUILD: "gen-w" }), log: quiet });
    const free = await currentGeneration({ repo, root, env: env({ SOVA_BUILD: "gen-f" }), log: quiet });
    await currentGeneration({ repo, root, env: env({ SOVA_BUILD: "gen-cur" }), log: quiet });
    for (const g of [old, helper, wd, free]) age(g.dir, 60 * 60_000);
    const scan = async () => ({
      // A chat the supervisor lost track of (a stop that failed), still running from gen-a; a helper of
      // gen-h's; a process of another root whose copy is named like none of ours.
      commands: [`/usr/bin/bun ${old.dir}/server/chat-runtime/main.ts`, `node ${helper.dir}/pi-config/extensions/spec/core/sova-spec.mjs map`, `bun /elsewhere/code/gen-z/server/chat-runtime/main.ts`],
      // A process whose working folder alone is in gen-w.
      cwds: [join(wd.dir, "server"), "/elsewhere/code/gen-y"],
    });
    const lines: string[] = [];
    const gc = startGenerationGc(() => [], { root, scan, log: (l) => lines.push(l) });
    await gc.collect();
    gc.stop();
    assert.ok(existsSync(old.dir) && existsSync(helper.dir) && existsSync(wd.dir), lines.join("\n"));
    assert.ok(!existsSync(free.dir), "nothing runs from gen-f: it goes");
  } finally {
    rmSync(base, { recursive: true, force: true });
    resetGenerations();
  }
});

test("a process scan that fails (no /proc, ps or lsof failing): nothing is collected, and it says why", async () => {
  const { base, repo, root } = checkout();
  try {
    const old = await currentGeneration({ repo, root, env: env({ SOVA_BUILD: "gen-a" }), log: quiet });
    await currentGeneration({ repo, root, env: env({ SOVA_BUILD: "gen-cur" }), log: quiet });
    age(old.dir, 60 * 60_000);
    const lines: string[] = [];
    const gc = startGenerationGc(() => [], { root, scan: async () => { throw new Error("lsof timed out"); }, log: (l) => lines.push(l) });
    await gc.collect();
    gc.stop();
    assert.ok(existsSync(old.dir));
    assert.ok(lines.includes("unused code is not collected now: ownership uncertain (lsof timed out)"), lines.join("\n"));
  } finally {
    rmSync(base, { recursive: true, force: true });
    resetGenerations();
  }
});

test("the Linux process scan: a pid that ended or can't be read is skipped; /proc that can't be listed, or lists no own pid, fails the scan", async () => {
  const gone = Object.assign(new Error("gone"), { code: "ENOENT" });
  const denied = Object.assign(new Error("denied"), { code: "EACCES" });
  const fake = {
    list: async () => ["1", "42", "77", "self"],
    cmdline: async (pid: string) => {
      if (pid === "42") throw gone;
      return `bun\0/code/gen-${pid}/server/chat-runtime/main.ts\0`;
    },
    cwd: async (pid: string) => {
      if (pid === "1") throw denied;
      return `/w/${pid}`;
    },
  };
  assert.deepEqual(await scanProcesses("linux", fake, undefined, 77), {
    commands: ["bun /code/gen-1/server/chat-runtime/main.ts ", "bun /code/gen-77/server/chat-runtime/main.ts "],
    cwds: ["/w/42", "/w/77"],
  });
  await assert.rejects(scanProcesses("linux", fake, undefined, 99), /\/proc does not list this server's own process/);
  await assert.rejects(scanProcesses("linux", { ...fake, list: async () => Promise.reject(gone) }, undefined, 77), /gone/);
  await assert.rejects(scanProcesses("win32", fake), /no process scan on win32/);
});

test("the macOS process scan: ps's commands and lsof's working folders, whatever the exit, when each lists this server's own pid; else the scan fails", async () => {
  const noProc = { list: async () => [], cmdline: async () => "", cwd: async () => "" };
  const ok = { code: 0, missing: false, timedOut: false };
  const ps = { ...ok, stdout: "  12 /bin/bun /c/gen-a/server/chat-runtime/main.ts\n 500 /bin/bun server/index.ts\n  13 login -pf\n" };
  const exec = (lsof: Partial<typeof ps>, p: Partial<typeof ps> = {}) => async (file: string) => (file === "ps" ? { ...ps, ...p } : { ...ok, stdout: "", ...lsof });
  // lsof exits 1 for a process it may not read, the rest printed: used.
  assert.deepEqual(await scanProcesses("darwin", noProc, exec({ code: 1, stdout: "p12\nfcwd\nn/c/gen-w/server\np500\nn/c/gen-x\n" }), 500), {
    commands: ["/bin/bun /c/gen-a/server/chat-runtime/main.ts", "/bin/bun server/index.ts", "login -pf"],
    cwds: ["/c/gen-w/server", "/c/gen-x"],
  });
  await assert.rejects(scanProcesses("darwin", noProc, exec({ code: 0, stdout: "p12\nn/c/gen-w\n" }), 500), /lsof does not list this server's own process/);
  await assert.rejects(scanProcesses("darwin", noProc, exec({ code: 1, stdout: "" }), 500), /lsof does not list/);
  await assert.rejects(scanProcesses("darwin", noProc, exec({ missing: true }), 500), /lsof is missing/);
  await assert.rejects(scanProcesses("darwin", noProc, exec({ timedOut: true }), 500), /lsof timed out/);
  await assert.rejects(scanProcesses("darwin", noProc, exec({ stdout: "p500\n" }, { code: 1, stdout: "  12 x\n" }), 500), /ps does not list this server's own process/);
  await assert.rejects(scanProcesses("darwin", noProc, exec({ stdout: "p500\n" }, { missing: true, stdout: "" }), 500), /ps is missing/);
});

test("a build id that is no directory name is hashed", () => {
  assert.equal(generationDir("abc+12345678", "/r"), "/r/abc+12345678");
  assert.match(generationDir("../x", "/r"), /^\/r\/h-[0-9a-f]{16}$/);
  assert.match(generationDir("deps", "/r"), /^\/r\/h-/);
});
