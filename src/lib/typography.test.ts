// Run: npx tsx --test src/lib/typography.test.ts (or npm test)
//
// The Typography catalogue and persistence shape, held against fixed strings: what an id
// resolves to, what a stored value reads as, and what a choice writes. Painting and precedence
// over the theme are theme.test.ts's.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkValue } from "../../shared/theme";
import {
  effectiveStack,
  fontById,
  isThemeDefault,
  MONO_FONTS,
  NO_TYPOGRAPHY,
  parseTypography,
  serializeTypography,
  TEXT_FONTS,
  typographyProperties,
} from "./typography";

test("the catalogue is the seven bundled families plus the two defaults, ids unique", () => {
  const ids = [...TEXT_FONTS, ...MONO_FONTS].map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(
    TEXT_FONTS.map((f) => f.id),
    ["inter", "source-sans-3", "atkinson-hyperlegible-next", "ibm-plex-sans", "noto-sans"],
  );
  assert.deepEqual(
    MONO_FONTS.map((f) => f.id),
    ["jetbrains-mono", "fira-code", "ibm-plex-mono", "source-code-pro"],
  );
});

test("every stack passes the theme file's own font grammar, and ends in its generic family", () => {
  // The same rule a theme's font-body has to meet: if the catalogue ever drifted to a value the
  // theme grammar refuses, a picked face would be a value no theme could have set.
  for (const f of TEXT_FONTS) {
    assert.equal(checkValue("font-body", f.stack), null, f.id);
    assert.ok(f.stack.endsWith("sans-serif"), `${f.id} falls through to sans-serif`);
  }
  for (const f of MONO_FONTS) {
    assert.equal(checkValue("font-mono", f.stack), null, f.id);
    assert.ok(f.stack.endsWith("monospace"), `${f.id} falls through to monospace`);
  }
});

test("fontById answers only within its own kind", () => {
  assert.equal(fontById("text", "inter")?.label, "Inter");
  assert.equal(fontById("mono", "inter"), null); // a text id is not a mono choice
  assert.equal(fontById("text", "fira-code"), null);
  assert.equal(fontById("text", null), null);
  assert.equal(fontById("mono", ""), null);
});

test("parseTypography: an id from the catalogue is a choice; anything else is Theme default", () => {
  assert.deepEqual(parseTypography(null), NO_TYPOGRAPHY);
  assert.deepEqual(parseTypography(""), NO_TYPOGRAPHY);
  assert.deepEqual(parseTypography("not json"), NO_TYPOGRAPHY);
  assert.deepEqual(parseTypography("[]"), NO_TYPOGRAPHY);
  assert.deepEqual(parseTypography('{"text":"noto-sans","mono":"fira-code"}'), { text: "noto-sans", mono: "fira-code" });
  // A stack string is not an id: the catalogue is closed, so a hand-edited value never lands.
  assert.deepEqual(parseTypography('{"text":"\\"Comic Sans\\", url(//x)","mono":"jetbrains-mono"}'), { text: null, mono: "jetbrains-mono" });
  // A kind's id in the other kind's slot is nothing.
  assert.deepEqual(parseTypography('{"text":"fira-code","mono":"inter"}'), NO_TYPOGRAPHY);
  assert.deepEqual(parseTypography('{"text":42}'), NO_TYPOGRAPHY);
});

test("serializeTypography round-trips, and Theme default stores nothing at all", () => {
  assert.equal(serializeTypography(NO_TYPOGRAPHY), null);
  const t = { text: "ibm-plex-sans", mono: null };
  assert.deepEqual(parseTypography(serializeTypography(t)), t);
  assert.equal(serializeTypography({ text: null, mono: "source-code-pro" }), '{"mono":"source-code-pro"}');
  assert.equal(isThemeDefault(NO_TYPOGRAPHY), true);
  assert.equal(isThemeDefault(t), false);
});

test("typographyProperties: text writes body AND display, mono writes mono, a null kind writes nothing", () => {
  assert.deepEqual(typographyProperties(NO_TYPOGRAPHY), {});
  const text = typographyProperties({ text: "atkinson-hyperlegible-next", mono: null });
  assert.equal(text["--font-body"], fontById("text", "atkinson-hyperlegible-next")!.stack);
  assert.equal(text["--font-display"], text["--font-body"]);
  assert.equal("--font-mono" in text, false);
  const mono = typographyProperties({ text: null, mono: "ibm-plex-mono" });
  assert.deepEqual(Object.keys(mono), ["--font-mono"]);
  assert.match(mono["--font-mono"]!, /^"IBM Plex Mono", /);
});

test("effectiveStack: the pick beats the theme's token, which beats the default", () => {
  const theme = { "font-body": '"Iosevka Aile", sans-serif', "font-mono": '"Iosevka", monospace' };
  assert.equal(effectiveStack("text", theme, NO_TYPOGRAPHY), theme["font-body"]);
  assert.equal(effectiveStack("mono", theme, NO_TYPOGRAPHY), theme["font-mono"]);
  assert.equal(effectiveStack("text", theme, { text: "inter", mono: null }), fontById("text", "inter")!.stack);
  assert.equal(effectiveStack("mono", theme, { text: "inter", mono: null }), theme["font-mono"]); // the other kind is untouched
  assert.equal(effectiveStack("text", {}, NO_TYPOGRAPHY), undefined); // tokens.css's default, not restated here
});
