import assert from "node:assert/strict";
import { test } from "node:test";
import { parseVis } from "../../parse";
import { buildSrcdoc, FRAME_CSP } from "./srcdoc";

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

test("free-form limit: 8 KB of source", () => {
  const big = `<div>${"x".repeat(8 * 1024)}</div>`;
  const r = parseVis("html", big);
  assert.equal(r.ok, false);
  assert.match((r as { message: string }).message, /at most 8 KB/);
  assert.ok(parseVis("html", `<div>${"x".repeat(8 * 1024 - 20)}</div>`).ok);
});

test("srcdoc: CSP and the motion gate come before the model's document, which goes in verbatim", () => {
  const doc = buildSrcdoc("html", "<script>requestAnimationFrame(f)</script>", "id1", ":root{}");
  const csp = doc.indexOf("Content-Security-Policy");
  const gate = doc.indexOf('id="sova-motion"');
  const hold = doc.indexOf("window.requestAnimationFrame=function");
  const model = doc.indexOf("<script>requestAnimationFrame(f)</script>");
  assert.ok(csp > 0 && csp < gate && gate < hold && hold < model, "policy, paused CSS and held timers precede the model's script");
  assert.match(doc, /default-src 'none'/);
  assert.doesNotMatch(FRAME_CSP, /allow-same-origin|https?:/);
});
