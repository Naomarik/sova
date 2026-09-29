// Run: pnpm exec tsx --test server/mesh/build-id.test.ts
// The boot record (§mesh.peers/resync, §mesh.details/fields): commit, dirty state and protocol
// taken together at boot, checked against the commit's own shared/protocol.ts, and kept however the
// checkout moves afterwards. A throwaway git repo stands in for the checkout.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, test } from "node:test";
import { bootBuild, captureBootBuild, checkBuild, realGit, resetBootBuild } from "./build-id";
import { BatteryReader, type Machine, realMachine } from "./details-collect";
import { fixedFacts } from "./details";
import { ownHello, primeFingerprint } from "./hello";

const tmp = mkdtempSync(join(tmpdir(), "sova-build-id-test-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => resetBootBuild());

// A checkout whose shared/protocol.ts is this tree's own, so its hash is the running protocol.
const repo = join(tmp, "repo");
mkdirSync(join(repo, "shared"), { recursive: true });
const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8" }).trim();
const protocolText = readFileSync(new URL("../../shared/protocol.ts", import.meta.url));
git("init", "-q", "-b", "main");
writeFileSync(join(repo, "shared/protocol.ts"), protocolText);
writeFileSync(join(repo, "README"), "one");
git("add", ".");
git("commit", "-q", "-m", "one");
const ONE = git("rev-parse", "HEAD");
const PROTO = primeFingerprint();
const hash16 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex").slice(0, 16);

describe("boot capture", () => {
  test("the running protocol is this tree's shared/protocol.ts (the precondition of every check below)", () => {
    assert.equal(PROTO, hash16(protocolText));
  });

  test("records the commit and protocol at once, then a clean, verified build", async () => {
    const pending = captureBootBuild({ root: repo, machine: realMachine });
    assert.equal(bootBuild()!.commit, ONE, "the commit is there before git's checks finish");
    assert.equal(bootBuild()!.protocol, PROTO);
    const done = await pending;
    assert.deepEqual(done, { commit: ONE, protocol: PROTO, dirty: false, verified: true });
    assert.deepEqual(bootBuild(), done);
  });

  test("the hello advertises the boot commit outside the fingerprint; before capture it doesn't", async () => {
    assert.equal("commit" in ownHello({ id: "a", label: "A" }), false);
    await captureBootBuild({ root: repo, machine: realMachine });
    const hello = ownHello({ id: "a", label: "A" });
    assert.equal(hello.commit, ONE);
    assert.equal(hello.protocol, PROTO, "the fingerprint is unchanged by the field");
  });

  test("the boot commit stays when HEAD moves afterwards, and the details report it", async () => {
    await captureBootBuild({ root: repo, machine: realMachine });
    writeFileSync(join(repo, "README"), "two");
    git("commit", "-q", "-am", "two");
    assert.notEqual(git("rev-parse", "HEAD"), ONE);
    assert.equal(bootBuild()!.commit, ONE);
    // a machine with no battery and no model: fixedFacts reads only the boot record's commit
    const machine: Machine = { ...realMachine, platform: "linux", read: () => null, list: () => [], run: async () => null };
    const facts = await fixedFacts(machine, new BatteryReader(machine));
    assert.equal(facts.commit, ONE);
    git("reset", "-q", "--hard", ONE);
  });

  test("tracked changes block it; an untracked file doesn't", async () => {
    writeFileSync(join(repo, "untracked.md"), "notes");
    assert.equal((await captureBootBuild({ root: repo, machine: realMachine })).blocked, undefined);
    writeFileSync(join(repo, "README"), "edited");
    const dirty = await captureBootBuild({ root: repo, machine: realMachine });
    assert.equal(dirty.dirty, true);
    assert.match(dirty.blocked!, /uncommitted changes on top of/);
    git("checkout", "-q", "--", "README");
    rmSync(join(repo, "untracked.md"));
  });

  test("a commit whose protocol isn't the running one blocks it; so does no commit, or one git can't read", async () => {
    const mismatch = await checkBuild(ONE, "0000000000000000", repo, realGit);
    assert.equal(mismatch.verified, false);
    assert.match(mismatch.blocked!, /protocol doesn't match/);
    assert.match((await checkBuild(undefined, PROTO, repo, realGit)).blocked!, /no commit on record/);
    const unreadable = await checkBuild("e".repeat(40), PROTO, repo, realGit);
    assert.equal(unreadable.verified, null);
    assert.match(unreadable.blocked!, /can't read/);
  });

  test("a git-archive deploy (BUILD_COMMIT, no .git): the commit is named, and resync from it is blocked", async () => {
    const deploy = join(tmp, "deploy");
    mkdirSync(deploy);
    writeFileSync(join(deploy, "BUILD_COMMIT"), JSON.stringify({ commit: ONE }));
    const b = await captureBootBuild({ root: deploy, machine: realMachine, git: async () => null });
    assert.equal(b.commit, ONE);
    assert.equal(b.dirty, null);
    assert.ok(b.blocked);
  });
});
