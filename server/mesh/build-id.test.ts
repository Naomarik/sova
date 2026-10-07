// Run: pnpm test -- server/mesh/build-id.test.ts
// The boot record (§mesh.peers/resync, §mesh.details/fields) without git: the running protocol is
// this tree's shared/protocol.ts (the precondition build-id.integration.test.ts relies on), and a
// git-archive deploy names its commit from BUILD_COMMIT. From a real checkout: the integration file.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, test } from "node:test";
import { captureBootBuild, resetBootBuild } from "./build-id";
import { realMachine } from "./details-collect";
import { primeFingerprint } from "./hello";

const tmp = mkdtempSync(join(tmpdir(), "sova-build-id-test-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => resetBootBuild());

const protocolText = readFileSync(new URL("../../shared/protocol.ts", import.meta.url));
const ONE = "1".repeat(40);
const PROTO = primeFingerprint();
const hash16 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex").slice(0, 16);

describe("boot capture", () => {
  test("the running protocol is this tree's shared/protocol.ts (the precondition of every check below)", () => {
    assert.equal(PROTO, hash16(protocolText));
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
