import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
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

// The guide's free-form examples (examples/*): each parses, fits the budget with room to spare,
// takes every colour from the theme, reaches for nothing over the network, and waits for the reader.
test("examples: parse, under the limit, theme colours only, no network, nothing autoplays", () => {
  const dir = new URL("./examples/", import.meta.url);
  const files = readdirSync(dir);
  assert.ok(files.length >= 3);
  for (const f of files) {
    const body = readFileSync(new URL(f, dir), "utf8");
    const r = parseVis(f.endsWith(".svg") ? "svg" : "html", body);
    assert.ok(r.ok, `${f}: ${r.ok ? "" : r.message}`);
    const { source, title, caption } = r.spec as { source: string; title?: string; caption?: string };
    assert.ok(title && caption, `${f}: title and caption`);
    assert.ok(new TextEncoder().encode(source).length < 7 * 1024, `${f}: under 7 KB`);
    assert.doesNotMatch(source, /[:=]\s*"?#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i, `${f}: colours come from var(--…)`);
    assert.doesNotMatch(source, /https?:\/\/(?!www\.w3\.org)/, `${f}: no network`);
    assert.doesNotMatch(source, /autoplay|setInterval|requestAnimationFrame/, `${f}: moves only on a click`);
    assert.match(source, /<button|role="button"/, `${f}: a control to drive it`);
  }
});
