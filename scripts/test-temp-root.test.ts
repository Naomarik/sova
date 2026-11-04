import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { assertTourBrowserTempPath } from "../server/tours/browser";
import { makeTestRoot, TEST_ROOT_PREFIX, testRootBase } from "./test-temp-root.mjs";

const MAC_DEFAULT = "/var/folders/ds/29xz27z13yn1k528t1vq85600000gn/T/";
const rootIn = (base: string) => join(base, `${TEST_ROOT_PREFIX}XXXXXX`);

test("macOS: a temp dir too long for Chromium's sockets gives way to /tmp; a short one stays", () => {
  assert.equal(testRootBase(MAC_DEFAULT, "darwin"), "/tmp");
  assert.equal(testRootBase("/tmp/q", "darwin"), "/tmp/q");
  assert.doesNotThrow(() => assertTourBrowserTempPath(rootIn(testRootBase(MAC_DEFAULT, "darwin"))));
});

test("Linux keeps its temp dir, however long", () => {
  assert.equal(testRootBase(MAC_DEFAULT, "linux"), MAC_DEFAULT);
  assert.equal(testRootBase(`/tmp/${"x".repeat(200)}`, "linux"), `/tmp/${"x".repeat(200)}`);
});

test("the runner's limit is the recorder's own: it moves exactly the temp dirs the recorder would refuse", () => {
  for (let n = 1; n < 80; n++) {
    const tmp = `/${"x".repeat(n)}`;
    let refused = false;
    try { assertTourBrowserTempPath(rootIn(tmp)); } catch { refused = true; }
    assert.equal(testRootBase(tmp, "darwin") === "/tmp", refused, `a temp dir of ${n + 1} bytes`);
  }
});

// lan-accept and lan-internet failed on every Mac run while a root under /tmp had /tmp's group, wheel.
test("macOS: a root under /tmp, and what's made below it, is this process's own group, not /tmp's", { skip: process.platform !== "darwin" ? "macOS only" : false }, (t) => {
  let control: string;
  try { control = mkdtempSync("/tmp/sova-root-check-"); } catch { return t.skip("/tmp is closed here"); }
  const root = makeTestRoot("/tmp");
  try {
    assert.notEqual(statSync(control).gid, process.getgid(), "control: a folder made under /tmp takes /tmp's group, so this test can tell");
    assert.equal(statSync(root).gid, process.getgid());
    mkdirSync(join(root, "a", "b"), { recursive: true });
    assert.equal(statSync(join(root, "a", "b")).gid, process.getgid(), "what's below inherits it");
    assert.equal(statSync(root).mode & 0o777, 0o700, "still private");
  } finally {
    rmSync(control, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
