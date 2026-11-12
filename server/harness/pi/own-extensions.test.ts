// Sova's own extensions and its mode engine in every chat (own-code.ts ownExtensions, patchResolve,
// ownCodeLoader): the mode slot is recognised by its folder against the REAL mode folder; a pi folder
// linked into a second, older Sova tree loads this copy's code only, with exactly one mode owner; a
// shipped extension the pi folder lacks is added (the production default); /extensions "off" stays off
// by name; a worktree's own agent dir keeps its tree's; a copied-sessions agent dir never runs wake-nudge.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { COPIED_SESSIONS_MARKER, isModeSlot, isSovaTree, modeFileOf, modesEntries, onOwnAgentDir, ownCodeLoader, ownExtensions, patchResolve, shippedExtensions, TEST_OWN_EXTENSIONS_ENV } from "./own-code";

const REPO = realpathSync(resolve(import.meta.dirname, "..", "..", ".."));
const REAL_MODE = join(REPO, "pi-config", "extensions", "mode");
const ENGINE = modesEntries(REPO).entry;
const OWN_EXT = join(REPO, "pi-config", "extensions");
const t = realpathSync(mkdtempSync(join(tmpdir(), "own-extensions-")));
after(() => rmSync(t, { recursive: true, force: true }));
const write = (p: string, text = "export default () => {};\n") => {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
};

// A second, older Sova tree (v0.9.0): the real mode folder as it was copied, a marker extension under a
// name this copy ships (btw) and one this copy doesn't ship (oldonly). Each marker writes a file when loaded.
const OLD = join(t, "old-sova");
write(join(OLD, "package.json"), JSON.stringify({ name: "sova", version: "0.9.0" }));
write(join(OLD, "pi-config", "install.sh"), "#!/bin/sh\n");
cpSync(REAL_MODE, join(OLD, "pi-config", "extensions", "mode"), { recursive: true, filter: (src) => !src.includes(`${REAL_MODE}/tests`) });
const loadedMark = (name: string) => join(t, `loaded-old-${name}`);
const marker = (name: string) =>
  `import { writeFileSync } from "node:fs";\nexport default function (pi) { writeFileSync(${JSON.stringify(loadedMark(name))}, "1"); pi.registerCommand("old-${name}", { description: "old", handler: async () => {} }); }\n`;
write(join(OLD, "pi-config", "extensions", "btw", "index.ts"), marker("btw"));
write(join(OLD, "pi-config", "extensions", "oldonly", "index.ts"), marker("oldonly"));
const OLD_EXT = join(OLD, "pi-config", "extensions");

// A branch's own tree (a worktree): btw changed there, and branchonly, which this copy doesn't ship; its
// `.agent` links every one of its extensions, as scripts/hermetic-agent-dir.mjs builds it.
const BRANCH = join(t, "branch");
write(join(BRANCH, "package.json"), JSON.stringify({ name: "sova", version: "0.16.0" }));
write(join(BRANCH, "pi-config", "install.sh"), "#!/bin/sh\n");
write(join(BRANCH, "pi-config", "extensions", "btw", "index.ts"));
write(join(BRANCH, "pi-config", "extensions", "branchonly", "index.ts"));
write(join(BRANCH, "server", "harness", "pi", "modes-entry.ts"));
const BRANCH_EXT = join(BRANCH, "pi-config", "extensions");
const BRANCH_AGENT = join(BRANCH, ".agent");
mkdirSync(join(BRANCH_AGENT, "extensions"), { recursive: true });
for (const n of ["btw", "branchonly"]) symlinkSync(join(BRANCH_EXT, n), join(BRANCH_AGENT, "extensions", n));

/** An agent dir whose extensions link to `links` (name → target), with `settings` and the user's own `mine.ts`. */
function agentDir(name: string, links: Record<string, string>, settings: object = {}, copied = false): string {
  const dir = join(t, name);
  mkdirSync(join(dir, "extensions"), { recursive: true });
  for (const [n, target] of Object.entries(links)) symlinkSync(target, join(dir, "extensions", n));
  write(join(dir, "extensions", "mine.ts"));
  writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
  if (copied) writeFileSync(join(dir, COPIED_SESSIONS_MARKER), JSON.stringify({ v: 1, sessions: [] }));
  return dir;
}

/** resolve()'s extensions for `dir` through pi's real package manager, patched with `env` (the production default: no knob). */
async function resolved(dir: string, env: NodeJS.ProcessEnv = { PI_CODING_AGENT_DIR: dir }, lines: string[] = [], own = REPO) {
  const cwd = join(t, "proj");
  mkdirSync(cwd, { recursive: true });
  const unpatch = patchResolve(DefaultPackageManager as never, null, (l) => lines.push(l), { own, env });
  try {
    const settingsManager = SettingsManager.create(cwd, dir);
    const pm = new DefaultPackageManager({ cwd, agentDir: dir, settingsManager });
    return (await pm.resolve()).extensions.filter((r) => !r.path.startsWith("builtin:"));
  } finally {
    unpatch();
  }
}
const shippedPaths = () => shippedExtensions(REPO).flatMap((s) => s.paths);

test("the mode slot is the folder: the real mode folder, its index.ts and a link to it; a mode folder with no index.ts too; nothing else", () => {
  assert.equal(isModeSlot(REAL_MODE), true);
  assert.equal(isModeSlot(join(REAL_MODE, "index.ts")), true);
  const agent = join(t, "slot-agent");
  mkdirSync(join(agent, "extensions"), { recursive: true });
  symlinkSync(REAL_MODE, join(agent, "extensions", "mode"));
  assert.equal(isModeSlot(join(agent, "extensions", "mode", "index.ts")), true, "through the agent dir's link");
  // Landing 2 deletes the pi mode extension's entry: the folder stays a mode slot without it.
  write(join(t, "next", "pi-config", "extensions", "mode", "minor.ts"));
  assert.equal(isModeSlot(join(t, "next", "pi-config", "extensions", "mode")), true, "no index.ts needed");
  assert.equal(isModeSlot(join(OWN_EXT, "spec")), false);
  assert.equal(isModeSlot(join(REAL_MODE, "spec-worker.ts")), false);
  assert.equal(isModeSlot(join(t, "mode")), false, "a folder named mode outside any extensions folder");
  assert.equal(modeFileOf(join(REAL_MODE, "spec-worker.ts")), "specWorker");
  assert.equal(modeFileOf(join(REAL_MODE, "project-tools-worker.ts")), "projectToolsWorker");
  assert.equal(modeFileOf(join(t, "next", "pi-config", "extensions", "mode")), "entry");
});

test("a Sova tree is recognised by its package.json name and pi-config/install.sh", () => {
  assert.equal(isSovaTree(REPO), true);
  assert.equal(isSovaTree(OLD), true);
  write(join(t, "not-sova", "package.json"), JSON.stringify({ name: "other" }));
  assert.equal(isSovaTree(join(t, "not-sova")), false);
  assert.ok(shippedExtensions(REPO).some((s) => s.name === "subagents"), "subagents is shipped");
  assert.ok(!shippedExtensions(REPO).some((s) => s.name === "mode" || s.name === "spec"), "the mode folder has its own rule; spec is tools, not an extension");
});

test("a pi folder linked into an older Sova tree: exactly one mode owner (Sova's engine), this copy's code for each shipped one, the old tree never", async () => {
  const dir = agentDir("old-links", { mode: join(OLD_EXT, "mode"), btw: join(OLD_EXT, "btw"), oldonly: join(OLD_EXT, "oldonly") });
  const lines: string[] = [];
  const out = await resolved(dir, { PI_CODING_AGENT_DIR: dir }, lines);
  const paths = out.map((r) => r.path);
  assert.deepEqual(paths.filter((p) => p === ENGINE || isModeSlot(p)), [ENGINE], "one mode owner");
  assert.equal(out.find((r) => r.path === ENGINE)!.enabled, true);
  assert.deepEqual(paths.filter((p) => realpathSync(p).startsWith(OLD)), [], "nothing of the old tree");
  assert.ok(paths.includes(join(OWN_EXT, "btw", "index.ts")), "btw is this copy's, in its slot");
  assert.ok(paths.includes(join(dir, "extensions", "mine.ts")), "the user's own extension stays where it is");
  assert.ok(!paths.some((p) => p.includes("oldonly")), "one this copy doesn't ship is left out");
  assert.deepEqual(
    lines.filter((l) => l.includes("oldonly")),
    [`the oldonly extension of another Sova copy (${OLD}) is not one this copy ships (${REPO}): left out (${join(dir, "extensions", "oldonly", "index.ts")})`],
    "the log names the extension and the other tree",
  );
  // Added: every other extension this copy ships, among the agent dir's own by name (where a link would be found).
  for (const p of shippedPaths()) assert.ok(paths.includes(p), `${p} added`);
});

test("a pi folder with no links at all: the engine and every shipped extension are added (the production default); the test knob adds only the engine", async () => {
  const dir = agentDir("no-links", {});
  const out = (await resolved(dir)).map((r) => r.path);
  assert.ok(out.includes(ENGINE));
  for (const p of shippedPaths()) assert.ok(out.includes(p), `${p} added`);
  assert.ok(out.includes(join(OWN_EXT, "wake-nudge.ts")), "wake-nudge too, on an agent dir with no copied sessions");
  const knob = (await resolved(dir, { PI_CODING_AGENT_DIR: dir, [TEST_OWN_EXTENSIONS_ENV]: "linked" })).map((r) => r.path);
  assert.deepEqual(knob.sort(), [join(dir, "extensions", "mine.ts"), ENGINE].sort(), "the knob never removes the engine");
});

test("an agent dir holding copied sessions never runs wake-nudge: neither added nor through a link", async () => {
  const dir = agentDir("copied", {}, {}, true);
  const out = (await resolved(dir)).map((r) => r.path);
  assert.ok(!out.some((p) => p.endsWith("wake-nudge.ts")), "the wake tool's extension is absent");
  assert.ok(out.includes(ENGINE) && out.includes(join(OWN_EXT, "subagents", "index.ts")), "the rest are added as ever");
  const linked = agentDir("copied-linked", { "wake-nudge.ts": join(OLD_EXT, "..", "..", "wake.ts") }, {}, true);
  write(join(OLD, "wake.ts"));
  assert.ok(!(await resolved(linked)).some((r) => r.path.endsWith("wake-nudge.ts")));
});

test("/extensions off stays off for Sova's own extensions, by name (linked into another copy, or not linked); modes stay on", async () => {
  const off = { extensions: ["!extensions/btw/index.ts", "!extensions/mode/index.ts", "-extensions/wake-nudge.ts"] };
  const linked = await resolved(agentDir("off-linked", { btw: join(OLD_EXT, "btw"), mode: join(OLD_EXT, "mode") }, off));
  assert.equal(linked.find((r) => r.path === join(OWN_EXT, "btw", "index.ts"))?.enabled, false, "remapped, still off");
  assert.equal(linked.find((r) => r.path === ENGINE)?.enabled, true, "the engine is always on");
  const missing = await resolved(agentDir("off-missing", {}, off));
  assert.equal(missing.find((r) => r.path === join(OWN_EXT, "btw", "index.ts"))?.enabled, false, "added, but off by its name");
  assert.equal(missing.find((r) => r.path === join(OWN_EXT, "wake-nudge.ts"))?.enabled, false, "a loose file by its name");
  assert.equal(missing.find((r) => r.path === join(OWN_EXT, "subagents", "index.ts"))?.enabled, true);
  assert.equal(missing.find((r) => r.path === ENGINE)?.enabled, true);
});

test("a worker on its worktree's own agent dir keeps that tree's extensions: no remap of another tree, nothing added but the engine", async () => {
  const dir = agentDir("tree-agent", { btw: join(OLD_EXT, "btw") });
  const env = { PI_CODING_AGENT_DIR: dir, SOVA_CHAT_STATE_ROOT: join(t, "server-agent", "sova") };
  assert.equal(onOwnAgentDir(dir, env), false);
  assert.equal(onOwnAgentDir(join(t, "server-agent"), env), true);
  const out = (await resolved(dir, env)).map((r) => r.path);
  assert.deepEqual(out.sort(), [join(dir, "extensions", "btw", "index.ts"), ENGINE, join(dir, "extensions", "mine.ts")].sort(), "pi's discovery order (the folder's), the engine among them");
  const listed = [join(OLD_EXT, "btw", "index.ts")];
  assert.deepEqual(ownCodeLoader({ noExtensions: true, additionalExtensionPaths: listed }, null, { own: REPO, env }).additionalExtensionPaths, listed, "listed: the tree's own");
  assert.deepEqual(ownCodeLoader({ noExtensions: true, additionalExtensionPaths: listed }, null, { own: REPO, env: { PI_CODING_AGENT_DIR: join(t, "x") } }).additionalExtensionPaths, [join(OWN_EXT, "btw", "index.ts")], "on Sova's own agent dir: this copy's");
});

test("what is added goes among the agent dir's own extensions where its name sorts; with none of those, at the end", () => {
  const dir = join(t, "order-agent");
  const user = { source: "auto", scope: "user", origin: "top-level", baseDir: dir };
  const pkg = { source: "npm", scope: "user", origin: "package" };
  const list = [
    { path: join(t, "pkg", "p.ts"), enabled: true, metadata: pkg },
    { path: join(dir, "extensions", "aaa.ts"), enabled: true, metadata: user },
    { path: join(dir, "extensions", "nnn.ts"), enabled: true, metadata: user },
    { path: join(dir, "extensions", "zzz.ts"), enabled: true, metadata: user },
  ];
  const out = ownExtensions(list, { agentDir: dir }, null, { own: REPO, env: {}, log: () => {} }).map((r) => r.path);
  assert.equal(out[0], join(t, "pkg", "p.ts"), "nothing goes before what isn't the agent dir's own");
  assert.ok(out.indexOf(join(dir, "extensions", "aaa.ts")) < out.indexOf(join(OWN_EXT, "btw", "index.ts")));
  assert.ok(out.indexOf(ENGINE) < out.indexOf(join(dir, "extensions", "nnn.ts")), "mode before nnn");
  assert.ok(out.indexOf(join(OWN_EXT, "sandbox", "index.ts")) > out.indexOf(join(dir, "extensions", "nnn.ts")), "sandbox after nnn");
  assert.ok(out.indexOf(join(OWN_EXT, "wake-nudge.ts")) < out.indexOf(join(dir, "extensions", "zzz.ts")));
  const bare = ownExtensions([list[0]!], { agentDir: dir }, null, { own: REPO, env: { [TEST_OWN_EXTENSIONS_ENV]: "linked" }, log: () => {} }).map((r) => r.path);
  assert.deepEqual(bare, [join(t, "pkg", "p.ts"), ENGINE]);
});

test("a project's own extension of a shipped name keeps Sova's from being added beside it", () => {
  const dir = join(t, "proj-agent");
  const proj = { source: "auto", scope: "project", origin: "top-level" };
  const list = [{ path: join(t, "proj", ".pi", "extensions", "sandbox", "index.ts"), enabled: true, metadata: proj }];
  const out = ownExtensions(list, { agentDir: dir }, null, { own: REPO, env: {}, log: () => {} }).map((r) => r.path);
  assert.ok(!out.includes(join(OWN_EXT, "sandbox", "index.ts")));
  assert.ok(out.includes(join(OWN_EXT, "subagents", "index.ts")));
});

test("exemption: a useWorktreeConfig helper on its branch's .agent loads that branch's extensions, one this copy doesn't ship included, with no left-out line", async () => {
  // Its server's state root is another agent dir's: this process is not on Sova's own agent dir.
  const env = { PI_CODING_AGENT_DIR: BRANCH_AGENT, SOVA_CHAT_STATE_ROOT: join(t, "server-agent", "sova") };
  const lines: string[] = [];
  const out = await resolved(BRANCH_AGENT, env, lines);
  const paths = out.map((r) => realpathSync(r.path === ENGINE ? ENGINE : r.path));
  assert.ok(paths.includes(join(BRANCH_EXT, "btw", "index.ts")), "the branch's btw, not this copy's");
  assert.ok(paths.includes(join(BRANCH_EXT, "branchonly", "index.ts")), "the branch's own extension loads");
  assert.ok(!paths.includes(join(OWN_EXT, "btw", "index.ts")));
  assert.deepEqual(lines, [], "nothing left out");
  // The contrast: the same .agent read as Sova's own agent dir would be remapped and lose branchonly.
  const asOwn: string[] = [];
  await resolved(BRANCH_AGENT, { PI_CODING_AGENT_DIR: BRANCH_AGENT }, asOwn);
  assert.ok(asOwn.some((l) => l.includes("the branchonly extension") && l.includes(BRANCH)), "without the exemption it would be left out");
  const listed = [join(BRANCH_EXT, "branchonly", "index.ts")];
  assert.deepEqual(ownCodeLoader({ noExtensions: true, additionalExtensionPaths: listed }, null, { own: REPO, env }).additionalExtensionPaths, listed, "listed: the branch's own");
});

test("exemption: a hermetic branch server (its .agent its own agent dir, its code the branch) loads the branch's extensions, with no left-out line, in the server and its chats", async () => {
  const engine = modesEntries(BRANCH).entry;
  for (const env of [
    { PI_CODING_AGENT_DIR: BRANCH_AGENT, [TEST_OWN_EXTENSIONS_ENV]: "linked" }, // the server itself
    { PI_CODING_AGENT_DIR: BRANCH_AGENT, SOVA_CHAT_STATE_ROOT: join(BRANCH_AGENT, "sova"), [TEST_OWN_EXTENSIONS_ENV]: "linked" }, // one of its chat processes
  ]) {
    const lines: string[] = [];
    const out = (await resolved(BRANCH_AGENT, env, lines, BRANCH)).map((r) => r.path);
    assert.deepEqual(out.sort(), [join(BRANCH_EXT, "branchonly", "index.ts"), join(BRANCH_EXT, "btw", "index.ts"), engine].sort(), "the branch's code only, its own engine");
    assert.deepEqual(lines, [], "nothing left out");
  }
  // The contrast: read by a server whose code is another copy (this checkout), branchonly would be left out.
  const other: string[] = [];
  await resolved(BRANCH_AGENT, { PI_CODING_AGENT_DIR: BRANCH_AGENT, [TEST_OWN_EXTENSIONS_ENV]: "linked" }, other, REPO);
  assert.ok(other.some((l) => l.includes("the branchonly extension") && l.includes(BRANCH)));
});

test("ownExtensions on a package manager with nothing to say: the mode slot still becomes the engine and stays one", () => {
  const meta = { source: "auto", scope: "user", origin: "top-level" };
  const two = [
    { path: join(REAL_MODE, "index.ts"), enabled: false, metadata: meta },
    { path: join(OLD_EXT, "mode", "index.ts"), enabled: true, metadata: meta },
  ];
  const out = ownExtensions(two, { agentDir: join(t, "none") }, null, { own: REPO, env: { [TEST_OWN_EXTENSIONS_ENV]: "linked" }, log: () => {} });
  assert.deepEqual(out, [{ path: ENGINE, enabled: true, metadata: meta }]);
});

test("loaded for real: the old tree's mode and marker code never runs; Sova's engine owns /mode and btw is this copy's", async () => {
  const { createAgentSessionServices, ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const dir = agentDir("load", { mode: join(OLD_EXT, "mode"), btw: join(OLD_EXT, "btw") });
  // The old mode folder's own entry, replaced by a marker so loading it would show.
  writeFileSync(join(OLD_EXT, "mode", "index.ts"), marker("mode"));
  const cwd = join(t, "proj");
  mkdirSync(cwd, { recursive: true });
  const unpatch = patchResolve(DefaultPackageManager as never, null, () => {}, { own: REPO, env: { PI_CODING_AGENT_DIR: dir, [TEST_OWN_EXTENSIONS_ENV]: "linked" } });
  try {
    const modelRuntime = await ModelRuntime.create({ authPath: join(t, "auth.json"), modelsPath: null, refreshOnCreate: false });
    const services = await createAgentSessionServices({ cwd, agentDir: dir, modelRuntime });
    const exts = services.resourceLoader.getExtensions().extensions as unknown as { path: string; commands: Map<string, unknown> }[];
    const owner = (cmd: string) => exts.filter((e) => e.commands.has(cmd)).map((e) => e.path);
    assert.deepEqual(owner("mode"), [ENGINE], "exactly one /mode, the engine's");
    assert.deepEqual(owner("btw"), [join(OWN_EXT, "btw", "index.ts")]);
    assert.deepEqual(owner("old-mode"), []);
    assert.deepEqual(owner("old-btw"), []);
    assert.equal(existsSync(loadedMark("mode")) || existsSync(loadedMark("btw")), false, "the old tree's code never ran");
    assert.ok(!readdirSync(t).some((n) => n.startsWith("loaded-old-")));
  } finally {
    unpatch();
  }
});

test("only the test runner ever sets the test knob: no other file of the tree names it", () => {
  // Who may name it: the runner's env (sets it), the loader (reads it), and the docs and tests about it.
  const allowed = new Set([
    "scripts/test-env.mjs",
    "server/harness/pi/own-code.ts",
    "server/harness/pi/own-extensions.test.ts",
    "server/harness/pi/quirks.ts",
    "server/harness/pi/QUIRKS.md",
    "agents/testing/overview.md",
    // Create's guide map: the SOVA_* names a user never sets.
    "server/create-guide-growth.json",
  ]);
  // The tree's own files (tracked, and untracked ones git doesn't ignore).
  const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: REPO, encoding: "utf8", maxBuffer: 64 << 20 }).split("\0").filter(Boolean);
  const found = files.filter((path) => {
    try {
      const st = statSync(join(REPO, path));
      if (!st.isFile() || st.size >= 4_000_000 || path.startsWith(".sova/")) return false;
      const text = readFileSync(join(REPO, path), "latin1");
      // By its name, or through the loader's constant for it.
      return text.includes(TEST_OWN_EXTENSIONS_ENV) || text.includes("TEST_OWN_EXTENSIONS_ENV");
    } catch {
      return false; // deleted in the work tree
    }
  });
  assert.deepEqual(found.filter((p) => !allowed.has(p)), [], "a file outside the runner names SOVA_TEST_OWN_EXTENSIONS: only scripts/test-env.mjs may set it");
  assert.ok(found.includes("scripts/test-env.mjs"), "the runner sets it");
});
