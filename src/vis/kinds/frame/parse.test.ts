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

test("free-form budget: characters, not bytes; over 8K draws with a 'large' warning, over 16K is an error", () => {
  const html = (chars: number) => `<p>${"x".repeat(chars - 7)}</p>`;
  const quiet = parseVis("html", html(8 * 1024));
  assert.ok(quiet.ok);
  assert.deepEqual(quiet.warnings, [], "8K characters exactly: no warning");
  // Multibyte text counts once per character: 8K characters of "é" are 16 KB of UTF-8.
  const accents = parseVis("html", `title: é\n<p>${"é".repeat(8 * 1024 - 7)}</p>`);
  assert.ok(accents.ok);
  assert.deepEqual(accents.warnings, []);
  const large = parseVis("html", html(9 * 1024 + 300));
  assert.ok(large.ok);
  assert.deepEqual(large.warnings, [{ line: 0, message: "large: 9.3K characters of html (aim under 8K)" }]);
  assert.deepEqual(large.spec.warnings, large.warnings);
  assert.ok(parseVis("svg", `<svg viewBox="0 0 1 1">${" ".repeat(16 * 1024 - 30)}</svg>`).ok);
  const r = err("html", html(16 * 1024 + 1));
  assert.equal(r.line, 0);
  assert.match(r.message, /16K characters of html; at most 16K \(aim under 8K\)/);
  // The title/caption lines are ours, outside the budget.
  assert.deepEqual((parseVis("html", `caption: ${"c".repeat(150)}\n${html(8 * 1024)}`) as { warnings: unknown[] }).warnings, []);
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
  // An svg's own width attribute is its natural size: only a width-less svg is stretched to fit.
  assert.match(buildSrcdoc("svg", "<svg/>", "id2", ""), /\.sova-svg>svg:not\(\[width\]\)\{width:100%\}/);
  // No vertical scrollbar below the height cap: the parent sizes the frame.
  assert.match(doc, /overflowY=v>1400\?"auto":"hidden"/);
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
