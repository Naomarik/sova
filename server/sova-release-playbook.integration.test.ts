import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
// @ts-expect-error: a plain .mjs driver, no types
import * as sr from "../.sova/playbooks/release/scripts/sova-release.mjs";

/**
 * Sova's release driver (.sova/playbooks/release/scripts/sova-release.mjs) run as the program its release checks and
 * the site deploy target run: its usage and exit codes. Nothing here uploads, deploys or runs a release check; the
 * logic is in sova-release-playbook.test.ts.
 */

const DRIVER = join(import.meta.dirname, "..", ".sova/playbooks/release/scripts/sova-release.mjs");
const dir = mkdtempSync(join(tmpdir(), "sova-release-int-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const run = (args: string[], env: Record<string, string> = {}, cwd = dir) => spawnSync(process.execPath, [DRIVER, ...args], { encoding: "utf8", cwd, env: { ...process.env, ...env } });

test("an unknown subcommand exits 2 and its usage lists every subcommand", () => {
  const u = run(["nope"]);
  assert.equal(u.status, 2);
  assert.deepEqual(/<([a-z|-]+)>/.exec(u.stderr)![1]!.split("|"), sr.SUBCOMMANDS);
});

test("env-set answers by exit code and never prints the value", () => {
  const set = run(["env-set", "SOVA_TEST_SITE_PROJECT"], { SOVA_TEST_SITE_PROJECT: "pages-project-secretish" });
  assert.equal(set.status, 0);
  assert.ok(!(set.stdout + set.stderr).includes("pages-project-secretish"));
  assert.equal(run(["env-set", "SOVA_TEST_SITE_PROJECT"], { SOVA_TEST_SITE_PROJECT: "" }).status, 1);
});

test("site-video stops a deploy without its hero video: SOVA_SITE_VIDEO_DIR unset, or a folder missing a video; site-pages without a Pages project uploads nothing", () => {
  const r = mkdtempSync(join(dir, "v-"));
  const unset = run(["site-video", r], { SOVA_SITE_VIDEO_DIR: "" });
  assert.equal(unset.status, 1);
  assert.match(unset.stderr, /SOVA_SITE_VIDEO_DIR is not set/);
  // A checkout whose manifest names a video the folder doesn't hold.
  const tree = mkdtempSync(join(dir, "t-"));
  mkdirSync(join(tree, "site", "src", "assets", "screens"), { recursive: true });
  mkdirSync(join(tree, "site", "scripts", "screens"), { recursive: true });
  copyFileSync(join(import.meta.dirname, "..", "site", "scripts", "screens", "add-video.mjs"), join(tree, "site", "scripts", "screens", "add-video.mjs"));
  writeFileSync(join(tree, "site", "src", "assets", "screens", "manifest.json"), readFileSync(join(import.meta.dirname, "..", "site", "src", "assets", "screens", "manifest.json")));
  const empty = mkdtempSync(join(dir, "e-"));
  const missing = run(["site-video", tree], { SOVA_SITE_VIDEO_DIR: empty });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /missing hero video/);
  assert.equal(run(["site-pages", "abc1234"], { SOVA_SITE_PAGES_PROJECT: "" }, r).status, 2);
});

test("docs-drift finds the trusted tools as spec-mode.md's line does: SOVA_SPEC_CORE, else the agent dir's (a leading ~ is home); none there: exit 2 naming where it looked", () => {
  const drift = join(import.meta.dirname, "..", ".sova/playbooks/release/scripts/docs-drift.mjs");
  const looked = (env: Record<string, string>) => {
    const r = spawnSync(process.execPath, [drift, "--base", "HEAD", "--root", dir], { encoding: "utf8", cwd: dir, env: { PATH: process.env.PATH ?? "", HOME: dir, ...env } });
    assert.equal(r.status, 2, r.stderr);
    return r.stderr.match(/^docs-drift: the spec tools aren't at (.*)$/m)?.[1];
  };
  assert.equal(looked({ SOVA_SPEC_CORE: join(dir, "own", "core"), PI_CODING_AGENT_DIR: join(dir, "agent") }), join(dir, "own", "core"), "Sova's own copy first");
  assert.equal(looked({ SOVA_SPEC_CORE: "", PI_CODING_AGENT_DIR: join(dir, "agent") }), join(dir, "agent", "extensions/spec/core"), "empty is unset");
  assert.equal(looked({ PI_CODING_AGENT_DIR: "~/a" }), join(dir, "a", "extensions/spec/core"));
  assert.equal(looked({}), join(dir, ".pi/agent", "extensions/spec/core"));
});
