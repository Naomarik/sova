// freshOrder (core/layout.mjs) puts records in the order one list would hold them: by area (the id up to its
// `/`), then by id, both as JS `<` compares strings. It must give exactly the order of the comparator sort it
// replaced, on Sova's own records and on ids built to catch a grouping that differs from a plain sort.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { freshOrder, readRecords } from "../core/layout.mjs";

const areaOf = (id) => id.slice(0, id.indexOf("/") >>> 0);
/** The comparator sort freshOrder replaced, kept here as the reference. */
function reference(records) {
  const keyed = Object.keys(records).map((id) => [areaOf(id), id]);
  keyed.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0));
  return Object.fromEntries(keyed.map(([, id]) => [id, records[id]]));
}
const same = (records) => {
  const got = freshOrder(records), want = reference(records);
  assert.deepEqual(Object.keys(got), Object.keys(want));
  for (const id of Object.keys(want)) assert.equal(got[id], want[id], `${id} keeps its own record object`);
};

test("freshOrder: ids where area order and plain id order disagree", () => {
  // "§app.chat" sorts after "§app" as an area although "§app.chat/x" < "§app/zzz" is false either way; "§app/chat"
  // is a prefix of "§app/chat-actions"; "-" (0x2d) sorts before "." (0x2e) and "/" (0x2f); an id with no "/" is
  // its own area.
  const ids = ["§app/zzz", "§app.chat/x", "§app/chat-actions", "§app/chat", "§app.chat-actions/a", "§app-x/b", "§app.chat/a",
    "§a/b", "§a.b/c", "§a-b/c", "§section.x/y", "§section/x", "§noslash", "§app/chat.x", "§b/a", "§a/z"];
  const records = Object.fromEntries(ids.map((id, i) => [id, { kind: "note", i }]));
  same(records);
  same(Object.fromEntries(Object.entries(records).reverse()));
  same({});
});

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
test("freshOrder: Sova's own records, in any input order", { skip: !existsSync(join(ROOT, ".sova/spec/manifest.json")) }, () => {
  const { records } = readRecords(ROOT);
  assert.ok(Object.keys(records).length > 1000);
  same(records);
  const shuffled = Object.keys(records).map((id, i) => [(i * 7919) % 1009, id]).sort((x, y) => x[0] - y[0]).map(([, id]) => [id, records[id]]);
  same(Object.fromEntries(shuffled));
});
