import assert from "node:assert/strict";
import { test } from "node:test";
import { parseVis } from "../../parse";

const err = (kind: string, body: string) => {
  const r = parseVis(kind, body);
  assert.equal(r.ok, false, `expected an error for:\n${body}`);
  return r as { ok: false; line: number; message: string };
};

test("html and svg keep their source; leading title/caption lines are ours", () => {
  const r = parseVis("html", 'title: Hash table\ncaption: "Try inserting keys"\n\n<div id="app"></div>\n<script>1</script>');
  assert.ok(r.ok);
  assert.deepEqual(r.spec, { kind: "html", title: "Hash table", caption: "Try inserting keys", source: '<div id="app"></div>\n<script>1</script>' });
  assert.match(err("svg", "<div></div>").message, /start with <svg/);
  assert.ok(parseVis("svg", '<svg viewBox="0 0 10 10"></svg>').ok);
});
