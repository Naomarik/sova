import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ownedCommand } from "./commands";
import { ownCode, ownCodeLoader, ownCodeOf, patchResolve } from "./own-code";

const t = realpathSync(mkdtempSync(join(tmpdir(), "own-code-")));
after(() => rmSync(t, { recursive: true, force: true }));
const touch = (p: string) => {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, "export default () => {};\n");
};
const live = join(t, "live");
const codeRoot = join(t, "code");
const own = join(codeRoot, "gen-b");
for (const root of [live, own, join(codeRoot, "gen-a")]) {
  touch(join(root, "pi-config", "extensions", "mode", "index.ts"));
  touch(join(root, "pi-config", "extensions", "spec", "index.ts"));
}
touch(join(live, "pi-config", "extensions", "fresh", "index.ts")); // added since gen-b was copied
const o = { own, live, codeRoot };
const mine = (name: string) => join(own, "pi-config", "extensions", name, "index.ts");

test("the mapping applies only in a chat process whose code is not the checkout", () => {
  assert.equal(ownCodeOf({}, own), null);
  assert.equal(ownCodeOf({ SOVA_CHAT_LIVE_ROOT: live }, live), null, "the checkout itself (the server, a live fallback)");
  assert.deepEqual(ownCodeOf({ SOVA_CHAT_LIVE_ROOT: live, SOVA_CHAT_COPIES_ROOT: codeRoot }, own), o);
});

test("a Sova pi-config path, the checkout's or another copy's, re-rooted in the own copy; anything else left alone", () => {
  assert.equal(ownCode(join(live, "pi-config", "extensions", "mode", "index.ts"), o), mine("mode"));
  assert.equal(ownCode(join(codeRoot, "gen-a", "pi-config", "extensions", "mode", "index.ts"), o), mine("mode"));
  assert.equal(ownCode(mine("mode"), o), mine("mode"));
  // Through a link, as the agent dir has them.
  mkdirSync(join(t, "agent", "extensions"), { recursive: true });
  symlinkSync(join(live, "pi-config", "extensions", "mode"), join(t, "agent", "extensions", "mode"));
  assert.equal(ownCode(join(t, "agent", "extensions", "mode", "index.ts"), o), mine("mode"));
  assert.equal(ownCode(join(live, "server", "x.ts"), o), null, "outside pi-config");
  assert.equal(ownCode(join(t, "elsewhere", "pi-config", "extensions", "mode", "index.ts"), o), null, "another checkout (a worktree's agent dir)");
});

test("resolve() patched: Sova extensions re-rooted, enabled flags and metadata kept, one the copy lacks left out; put back after", async () => {
  const meta = { source: "local", scope: "user", origin: "top-level" };
  class FakePm {
    async resolve() {
      return {
        extensions: [
          { path: join(live, "pi-config", "extensions", "mode", "index.ts"), enabled: true, metadata: meta },
          { path: join(live, "pi-config", "extensions", "spec", "index.ts"), enabled: false, metadata: meta },
          { path: join(live, "pi-config", "extensions", "fresh", "index.ts"), enabled: true, metadata: meta },
          { path: join(t, "pkg", "a.ts"), enabled: true, metadata: { ...meta, origin: "package" } },
        ],
        skills: [{ path: join(live, "pi-config", "skills", "s", "SKILL.md"), enabled: true, metadata: meta }],
      };
    }
  }
  const lines: string[] = [];
  const unpatch = patchResolve(FakePm as never, o, (l) => lines.push(l));
  const out = (await new FakePm().resolve()) as Awaited<ReturnType<FakePm["resolve"]>>;
  assert.deepEqual(out.extensions, [
    { path: mine("mode"), enabled: true, metadata: meta },
    { path: mine("spec"), enabled: false, metadata: meta },
    { path: join(t, "pkg", "a.ts"), enabled: true, metadata: { ...meta, origin: "package" } },
  ]);
  assert.equal(out.skills[0]!.path, join(live, "pi-config", "skills", "s", "SKILL.md"), "skills are data: read live");
  assert.ok(lines.some((l) => /fresh\/index\.ts is not in this chat's code \(gen-b\): left out/.test(l)));
  unpatch();
  assert.equal((await new FakePm().resolve()).extensions[0]!.path, join(live, "pi-config", "extensions", "mode", "index.ts"));
});

test("a worker's listed extensions mapped; one missing from its copy fails the build with the reason", () => {
  const listed = [join(live, "pi-config", "extensions", "spec", "index.ts"), "npm:some-pkg", join(t, "other.ts")];
  assert.deepEqual(ownCodeLoader({ noExtensions: true, additionalExtensionPaths: listed }, o), { noExtensions: true, additionalExtensionPaths: [mine("spec"), "npm:some-pkg", join(t, "other.ts")] });
  assert.throws(
    () => ownCodeLoader({ noExtensions: true, additionalExtensionPaths: [join(live, "pi-config", "extensions", "fresh", "index.ts")] }, o),
    /pi-config\/extensions\/fresh\/index\.ts is not in this chat's code \(gen-b\); reload the parent chat/,
  );
  const same = { noExtensions: true, additionalExtensionPaths: listed };
  assert.equal(ownCodeLoader(same, null), same, "no mapping: unchanged");
});

test("a mapped path still names its owner's command (ownedCommand matches the file under any root)", () => {
  const runner = (path: string) => ({ getCommand: () => ({ sourceInfo: { path } }) });
  assert.ok(ownedCommand(runner(mine("mode")), "mode"));
  assert.ok(ownedCommand(runner(join(own, "pi-config", "extensions", "subagents", "index.ts")), "agent-resume"));
});
