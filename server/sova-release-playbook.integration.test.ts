import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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

test("site-video never fails a deploy: without SOVA_SITE_VIDEO_DIR it ships without the video and says so; site-pages without a Pages project uploads nothing", () => {
  const r = mkdtempSync(join(dir, "v-"));
  const out = run(["site-video", r], { SOVA_SITE_VIDEO_DIR: "" });
  assert.equal(out.status, 0);
  assert.match(out.stdout, /without its hero video/);
  assert.equal(run(["site-pages", "abc1234"], { SOVA_SITE_PAGES_PROJECT: "" }, r).status, 2);
});
