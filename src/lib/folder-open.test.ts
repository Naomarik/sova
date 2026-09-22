// Run: npx tsx --test src/lib/folder-open.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  folderOpen,
  folderOpenKey,
  legacyFolderOpenKey,
  storedFolderOpen,
} from "./folder-open";

const quiet = { searching: false, holdsSelected: false };

test("open by default: a folder nobody has collapsed shows its rows", () => {
  assert.equal(folderOpen({ ...quiet }), true);
  assert.equal(folderOpen({ ...quiet, stored: undefined }), true);
});

test("the stored choice wins while nothing forces it open", () => {
  assert.equal(folderOpen({ ...quiet, stored: false }), false);
  assert.equal(folderOpen({ ...quiet, stored: true }), true);
});

test("searching and the selected session force it open, collapsed or not", () => {
  assert.equal(folderOpen({ stored: false, searching: true, holdsSelected: false }), true);
  assert.equal(folderOpen({ stored: false, searching: false, holdsSelected: true }), true);
  assert.equal(folderOpen({ stored: false, searching: true, holdsSelected: true }), true);
});

test("a forced-open folder goes back to the stored choice when the force ends", () => {
  const collapsed = { stored: false };
  assert.equal(folderOpen({ ...collapsed, searching: true, holdsSelected: false }), true);
  assert.equal(folderOpen({ ...collapsed, ...quiet }), false);
});

test("only \"1\" and \"0\" are a choice; anything else is nobody having chosen", () => {
  assert.equal(storedFolderOpen("1"), true);
  assert.equal(storedFolderOpen("0"), false);
  assert.equal(storedFolderOpen(null), undefined);
  assert.equal(storedFolderOpen(undefined), undefined);
  assert.equal(storedFolderOpen(""), undefined);
  assert.equal(storedFolderOpen("true"), undefined);
  // The distinction that matters: an unset key must not read as collapsed.
  assert.equal(folderOpen({ ...quiet, stored: storedFolderOpen(null) }), true);
  assert.equal(folderOpen({ ...quiet, stored: storedFolderOpen("0") }), false);
});

test("the key separates the same folder in different regions", () => {
  const cwd = "/home/user/webapps/pi-web";
  const keys = ["t", "a-today", "g-abc123"].map((prefix) => folderOpenKey(prefix, cwd));
  assert.equal(new Set(keys).size, keys.length);
  // ...and two folders inside one region, whose paths share a prefix.
  assert.notEqual(folderOpenKey("t", "/home/user/webapps"), folderOpenKey("t", "/home/user/webapps/pi-web"));
  for (const k of keys) assert.match(k, /^sova:folder-open-/);
});

test("the legacy pre-rebrand key is the same shape under the old prefix", () => {
  assert.equal(legacyFolderOpenKey("t", "/x"), "pi-web:folder-open-t-/x");
  assert.equal(folderOpenKey("t", "/x"), "sova:folder-open-t-/x");
});
