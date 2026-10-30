import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildId } from "../chat-runtime/generations";
import { diskAheadOf } from "./disk-ahead";
import { gitIn } from "./git";
import { makeRepos } from "./testing";

/**
 * Restart Sova's "It loads newer code": commits since the server's start, and changes not committed
 * since then, by the same build id a chat's "On older code" uses. A stand-in repository; local git only.
 */

const env = (): NodeJS.ProcessEnv => {
  const e = { ...process.env };
  delete e.SOVA_BUILD;
  return e;
};

test("nothing new, new commits, new changes, both; changes it started with don't count", async () => {
  const r = makeRepos("disk-ahead-");
  r.commit(r.origin, "first");
  const copy = r.clone("copy");
  const git = gitIn(copy);
  const startedHead = r.git(copy, "rev-parse", "HEAD");
  const now = () => buildId(copy, env());
  const ahead = async (startBuild: string | null) => diskAheadOf({ git, startedHead, startBuild, buildNow: now });

  const start = await now();
  assert.equal(start, startedHead, "a clean tree's build is its commit");
  assert.equal(await ahead(start), null, "nothing newer");

  writeFileSync(join(copy, "file.txt"), "edited\n");
  assert.deepEqual(await ahead(start), { commits: 0, dirty: true });
  // The server started on these very changes: nothing newer.
  assert.equal(await ahead(await now()), null);

  r.commit(copy, "second");
  r.commit(copy, "third");
  assert.deepEqual(await ahead(start), { commits: 2, dirty: false });
  writeFileSync(join(copy, "file.txt"), "edited again\n");
  assert.deepEqual(await ahead(start), { commits: 2, dirty: true });
  // Nobody recorded the start's build: any changes count.
  assert.deepEqual(await ahead(null), { commits: 2, dirty: true });
});

test("git can't say: null, never a guess", async () => {
  const r = makeRepos("disk-ahead-bad-");
  r.commit(r.origin, "first");
  const copy = r.clone("copy");
  const gone = "f".repeat(40);
  assert.equal(await diskAheadOf({ git: gitIn(copy), startedHead: gone, startBuild: "x", buildNow: async () => "y" }), null);
  assert.equal(await diskAheadOf({ git: gitIn(copy), startedHead: null, startBuild: "x", buildNow: async () => "unknown" }), null);
});
