// Run: npx tsx --test src/lib/path-attachments.test.ts
// Render-level checks for §4b path chips: the HTML markdown emits, and where chips never go.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { TmpAttachment } from "../../shared/protocol";
import { findTmpImagePaths } from "../../shared/tmp-paths";
import { renderMarkdown } from "./markdown";
import { chipHtml, shortName, stripPastedPaths } from "./path-attachments";

const uuid = "a58752a9-8229-46d3-a816-07ef24919b10";
const path = `/tmp/pi-clipboard-${uuid}.png`;
const gone: TmpAttachment = { path, name: path.slice(5), mimeType: "image/png", available: false };
const here: TmpAttachment = { ...gone, size: 233224, available: true };
const chips = (html: string) => html.match(/<button type="button" class="path-chip[^"]*"/g)?.length ?? 0;

describe("chip markup", () => {
  test("short name keeps the prefix and 4 uuid characters", () => {
    assert.equal(shortName(gone.name), "pi-clipboard-a587….png");
    assert.equal(shortName("debug-shot.png"), "debug-shot.png");
  });

  test("a gone file: compact, says so, full path only in title/label, copies on click", () => {
    const html = chipHtml(gone);
    assert.match(html, /class="path-chip path-chip-missing"/);
    assert.match(html, /<span class="path-chip-name">pi-clipboard-a587….png<\/span>/);
    assert.match(html, /<span class="path-chip-note">· No longer on disk<\/span>/);
    assert.match(html, new RegExp(`aria-label="Copy path ${path}, no longer on disk"`));
    assert.match(html, new RegExp(`title="${path} · No longer on disk. Select to copy the path."`));
    assert.doesNotMatch(html, /data-available|aria-haspopup/);
    // The long path never shows as visible text.
    assert.equal(html.replace(/<[^>]+>/g, "").includes(path), false);
  });

  test("an available file opens the lightbox", () => {
    const html = chipHtml(here);
    assert.match(html, /class="path-chip" data-path-chip="\/tmp\/pi-clipboard-[^"]+" data-available aria-haspopup="dialog"/);
    assert.match(html, /aria-label="Open image pi-clipboard-/);
    assert.doesNotMatch(html, /path-chip-note/);
  });

  test("attribute values are escaped", () => {
    const odd: TmpAttachment = { path: '/tmp/a"b.png', name: 'a"b.png', mimeType: "image/png", available: false };
    assert.doesNotMatch(chipHtml(odd), /a"b/);
  });
});

describe("renderMarkdown with attachments", () => {
  test("a path in prose becomes a chip in place; the sentence stays", () => {
    const { html } = renderMarkdown(`See ${path} for the layout.`, false, [gone]);
    assert.equal(chips(html), 1);
    assert.match(html, /^<p>See <button[^]*<\/button> for the layout\.<\/p>/);
  });

  test("in a table cell, a list item and bold text too", () => {
    const { html } = renderMarkdown(`| a |\n|---|\n| ${path} |\n\n- ${path}\n\n**${path}**`, false, [gone]);
    assert.equal(chips(html), 3);
  });

  test("never in inline code, fenced code, or without the server listing it", () => {
    const text = `\`${path}\`\n\n\`\`\`\n${path}\n\`\`\`\n\n    ${path}`;
    assert.equal(chips(renderMarkdown(text, false, [gone]).html), 0);
    assert.equal(chips(renderMarkdown(`See ${path}.`).html), 0);
    assert.equal(chips(renderMarkdown(`See ${path}.`, false, []).html), 0);
  });

  test("wildcard and placeholder mentions stay text", () => {
    const text = "Paths like /tmp/pi-clipboard-*.png and /tmp/pi-clipboard-<uuid>.png render as raw text.";
    assert.equal(chips(renderMarkdown(text, false, [gone]).html), 0);
  });
});

describe("findTmpImagePaths (plain-text rows split on it)", () => {
  test("offsets point at the path", () => {
    const text = `report: ${path}; done`;
    const [m] = findTmpImagePaths(text);
    assert.equal(text.slice(m!.start, m!.end), path);
  });
});

describe("pi-web uploads (/tmp/pi-web-<uuid>.<ext>)", () => {
  const web = `/tmp/pi-web-${uuid}.png`;

  test("short name keeps the prefix and 4 uuid characters", () => {
    assert.equal(shortName(web.slice(5)), "pi-web-a587….png");
    assert.equal(shortName("pi-web-notauuid.png"), "pi-web-notauuid.png");
  });

  test("a path glued after a sentence is found; one in a code fence is not", () => {
    const text = `what's wrong here?\n${web}`;
    const [m] = findTmpImagePaths(text);
    assert.equal(m?.path, web);
    assert.equal(text.slice(m!.start, m!.end), web);
    assert.deepEqual(findTmpImagePaths(`what's wrong here? ${web}.`).map((x) => x.path), [web]);
    assert.deepEqual(findTmpImagePaths(`\`\`\`\n${web}\n\`\`\``), []);
  });

  test("stripPastedPaths drops upload paths like the server's user rows; typed paths stay", () => {
    assert.equal(stripPastedPaths(`look at this\n${web}\n${path}`), "look at this");
    assert.equal(stripPastedPaths(`a ${web} b`), "a b");
    assert.equal(stripPastedPaths(web), "");
    assert.equal(stripPastedPaths("compare /tmp/pi-web-notauuid.png."), "compare /tmp/pi-web-notauuid.png.");
    assert.equal(stripPastedPaths(`\`${web}\``), `\`${web}\``);
  });
});

describe("draft attachments (<agent dir>/pi-web/attachments/<sessionId>/pi-web-<uuid>.<ext>)", () => {
  const sid = "019a1b2c-3d4e-7f80-9a1b-2c3d4e5f6a7b";
  const att = `/home/me/.pi/agent/pi-web/attachments/${sid}/pi-web-${uuid}.png`;

  test("is recognised, and stripped from a user row like a /tmp upload", () => {
    assert.deepEqual(findTmpImagePaths(`what's wrong here?\n${att}`).map((m) => m.path), [att]);
    assert.equal(stripPastedPaths(`what's wrong here?\n${att}`), "what's wrong here?");
    assert.equal(stripPastedPaths(`a ${att} b\n${path}`), "a b");
  });

  test("lookalikes outside that tail stay text", () => {
    const noSession = `/home/me/.pi/agent/pi-web/attachments/pi-web-${uuid}.png`;
    const otherRoot = `/home/me/.pi/agent/pi-web/uploads/${sid}/pi-web-${uuid}.png`;
    const nested = `/home/me/.pi/agent/pi-web/attachments/${sid}/deeper/pi-web-${uuid}.png`;
    for (const p of [noSession, otherRoot, nested]) {
      assert.deepEqual(findTmpImagePaths(`see ${p}`), [], p);
      assert.equal(stripPastedPaths(`see ${p}`), `see ${p}`);
    }
  });

  test("the gone note names no folder", () => {
    const html = chipHtml({ path: att, name: `pi-web-${uuid}.png`, mimeType: "image/png", available: false });
    assert.match(html, /<span class="path-chip-note">· No longer on disk<\/span>/);
    assert.doesNotMatch(html, /\/tmp/);
  });
});
