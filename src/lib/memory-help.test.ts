// "How memory works" (§chat.memory/help): every drawing parses clean, the figures the card states are
// the engine's own, and the card opens on the saved default type.
import assert from "node:assert/strict";
import { test } from "node:test";
import { MEMORY_SIZES, MEMORY_TYPE_INFO } from "../../shared/memory";
import { WAIT_MS } from "../../server/memory/engine";
import { DEFAULT_SUMMARIZER } from "../../server/memory/settings";
import { LIMIT } from "../../server/memory/tree";
import { parseVis } from "../vis/parse";
import { modelLabel } from "./format";
import { HELP_DEFAULT_SUMMARIZER, HELP_LINE_CHARS, HELP_WAIT_SECONDS, initialHelpTab, MEMORY_HELP_SETTINGS, MEMORY_HELP_TABS } from "./memory-help";

test("every drawing parses with no hard error and no warning", () => {
  for (const t of MEMORY_HELP_TABS) {
    assert.ok(t.drawings.length >= 1 && t.drawings.length <= 2, `${t.type}: 1 or 2 drawings`);
    for (const d of t.drawings) {
      const r = parseVis(d.kind, d.body);
      assert.ok(r.ok, `${t.type} ${d.kind}: ${r.ok ? "" : `line ${r.line}: ${r.message}`}`);
      assert.deepEqual(r.warnings, [], `${t.type} ${d.kind} warns`);
    }
  }
});

test("each type has one tab, in the menu's order, with 3–4 sentences", () => {
  assert.deepEqual(
    MEMORY_HELP_TABS.map((t) => [t.type, t.label]),
    MEMORY_TYPE_INFO.map((t) => [t.id, t.label]),
  );
  for (const t of MEMORY_HELP_TABS) assert.ok(t.sentences.length >= 3 && t.sentences.length <= 4, t.type);
});

test("UniiChat credits Victor Taelin and links his design; Zoomable compaction credits no one", () => {
  const [uniichat, zoomable] = MEMORY_HELP_TABS;
  assert.equal(uniichat!.by, "by Victor Taelin");
  assert.equal(uniichat!.link, "https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449");
  assert.equal(zoomable!.by, undefined);
  assert.equal(zoomable!.link, undefined);
});

test("the figures it states are the engine's", () => {
  // About 500 characters for a 512-byte ask: rounded down, never past what the summarizer is asked for.
  assert.ok(HELP_LINE_CHARS <= LIMIT && LIMIT - HELP_LINE_CHARS < 50);
  assert.equal(HELP_WAIT_SECONDS * 1000, WAIT_MS);
  assert.equal(HELP_DEFAULT_SUMMARIZER, `${modelLabel(DEFAULT_SUMMARIZER.model)} at ${DEFAULT_SUMMARIZER.effort} effort`);
  const all = [...MEMORY_HELP_TABS.flatMap((t) => t.sentences), ...MEMORY_HELP_SETTINGS.map((s) => s.text)].join(" ");
  assert.match(all, new RegExp(`about ${HELP_LINE_CHARS} characters`));
  assert.match(all, /64–128 KB by default/);
  assert.match(all, /32 KB by default/);
  assert.match(all, new RegExp(`\\(${MEMORY_SIZES[0]} to ${MEMORY_SIZES.at(-1)} KB\\)`));
  assert.match(all, new RegExp(`up to ${HELP_WAIT_SECONDS} seconds`));
});

test("plain words: none of the engine's jargon", () => {
  const all = [...MEMORY_HELP_TABS.flatMap((t) => [...t.sentences, ...t.drawings.map((d) => d.body)]), ...MEMORY_HELP_SETTINGS.map((s) => `${s.term} ${s.text}`)].join(" ");
  for (const word of ["rebase", "cache", "token", "prefix", "node"]) assert.doesNotMatch(all.toLowerCase(), new RegExp(`\\b${word}`), word);
});

test("the card opens on the saved default type, else UniiChat", () => {
  assert.equal(initialHelpTab(undefined), "uniichat");
  assert.equal(initialHelpTab("zoomable"), "zoomable");
  assert.equal(initialHelpTab("uniichat"), "uniichat");
  assert.equal(initialHelpTab("other" as never), "uniichat");
});
