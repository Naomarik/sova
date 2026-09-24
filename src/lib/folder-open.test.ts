// Run: npx tsx --test src/lib/folder-open.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  folderActive,
  folderOpen,
  folderOpenKey,
  storedFolderOpen,
} from "./folder-open";

const quiet = { searching: false };

test("collapsed by default: a folder nobody has opened hides its rows", () => {
  assert.equal(folderOpen({ ...quiet }), false);
  assert.equal(folderOpen({ ...quiet, stored: undefined }), false);
});

test("the stored choice wins while nothing forces it open", () => {
  assert.equal(folderOpen({ ...quiet, stored: false }), false);
  assert.equal(folderOpen({ ...quiet, stored: true }), true);
});

test("searching forces it open, collapsed or not", () => {
  assert.equal(folderOpen({ stored: false, searching: true }), true);
  assert.equal(folderOpen({ stored: undefined, searching: true }), true);
});

test("a forced-open folder goes back to the stored choice when the search ends", () => {
  const collapsed = { stored: false };
  assert.equal(folderOpen({ ...collapsed, searching: true }), true);
  assert.equal(folderOpen({ ...collapsed, ...quiet }), false);
});

test("only \"1\" and \"0\" are a choice; anything else is nobody having chosen", () => {
  assert.equal(storedFolderOpen("1"), true);
  assert.equal(storedFolderOpen("0"), false);
  assert.equal(storedFolderOpen(null), undefined);
  assert.equal(storedFolderOpen(undefined), undefined);
  assert.equal(storedFolderOpen(""), undefined);
  assert.equal(storedFolderOpen("true"), undefined);
  // The distinction that matters: an unset key must not read as a choice to open.
  assert.equal(folderOpen({ ...quiet, stored: storedFolderOpen(null) }), false);
  assert.equal(folderOpen({ ...quiet, stored: storedFolderOpen("1") }), true);
});

test("the key separates the same folder in different regions", () => {
  const cwd = "/home/user/webapps/sova";
  const keys = ["t", "a-today", "g-abc123"].map((prefix) => folderOpenKey(prefix, cwd));
  assert.equal(new Set(keys).size, keys.length);
  // ...and two folders inside one region, whose paths share a prefix.
  assert.notEqual(folderOpenKey("t", "/home/user/webapps"), folderOpenKey("t", "/home/user/webapps/sova"));
  for (const k of keys) assert.match(k, /^sova:folder-open-/);
});

test("the key is the region prefix and the folder under the sova: prefix", () => {
  assert.equal(folderOpenKey("t", "/x"), "sova:folder-open-t-/x");
});

const row = (over: Partial<{ path: string; busy: boolean; live: { pid: number; status: string; workers?: { working: number; total: number } } | null; workers: { working: number; total: number } }> = {}) => ({
  path: "/s/a.jsonl",
  busy: false,
  live: null,
  ...over,
});

test("folderActive: an idle folder shows no indicator", () => {
  assert.equal(folderActive([]), false);
  assert.equal(folderActive([row(), row({ path: "/s/b.jsonl", workers: { working: 0, total: 3 } })]), false);
  assert.equal(folderActive([row({ live: { pid: 1, status: "Idle" } })]), false);
});

test("folderActive: any one busy row, TUI turn or working subagent lights the folder", () => {
  assert.equal(folderActive([row(), row({ path: "/s/b.jsonl", busy: true })]), true);
  assert.equal(folderActive([row({ live: { pid: 1, status: "Running: bash, read" } })]), true);
  assert.equal(folderActive([row({ workers: { working: 2, total: 2 } })]), true);
  assert.equal(folderActive([row({ live: { pid: 1, status: "Idle", workers: { working: 1, total: 1 } } })]), true);
});

test("folderActive: this tab's own run wins over the fetched busy flag, both ways", () => {
  assert.equal(folderActive([row({ busy: false })], { "/s/a.jsonl": true }), true);
  assert.equal(folderActive([row({ busy: true })], { "/s/a.jsonl": false }), false);
});
