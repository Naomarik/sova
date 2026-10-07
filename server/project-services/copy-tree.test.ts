// Run: pnpm test -- server/project-services/copy-tree.test.ts
// A data `from` copy with the host's own cp (§app.project-services/contract): GNU cp on Linux,
// BSD cp's clone flag on macOS (which rejects --reflink), and a real copy on this host.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { copyContentsArgv } from "./copy-tree";

const tmp = mkdtempSync(join(tmpdir(), "sova-copy-tree-test-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

test("the cp argv: GNU's --reflink=auto off macOS, BSD's -c on macOS, never both", () => {
  assert.deepEqual(copyContentsArgv("/s", "/d", "linux"), ["-a", "--reflink=auto", "/s/.", "/d"]);
  assert.deepEqual(copyContentsArgv("/s", "/d", "darwin"), ["-a", "-c", "/s/.", "/d"]);
});
