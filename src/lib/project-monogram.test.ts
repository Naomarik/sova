import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PROJECT_TINTS, projectLetters, projectTint } from "./project-monogram";

test("letters: two like an avatar", () => {
  const cases: [string, string][] = [
    ["Sova", "So"],
    ["Landing Site", "LS"],
    ["acme-api", "AA"],
    ["LandingSite", "LS"],
    ["API", "AP"],
    ["x", "X"],
    ["", "?"],
    ["   ", "?"],
    ["🚀", "🚀"],
    ["🚀 Rocket", "Ro"],
    ["my_app.web", "MA"],
    ["v2Engine", "VE"],
  ];
  for (const [name, want] of cases) assert.equal(projectLetters(name), want, name);
});

test("tint: stable by id, unchanged by a rename, spread over the palette", () => {
  assert.equal(projectTint("prj_abc12345"), projectTint("prj_abc12345"));
  assert.ok(PROJECT_TINTS.includes(projectTint("prj_abc12345") as (typeof PROJECT_TINTS)[number]));
  // The name never enters it: the same id, any name, one colour (the API takes only the id).
  assert.equal(projectTint.length, 1);
  const seen = new Set(Array.from({ length: 200 }, (_, i) => projectTint(`prj_${i.toString(36).padStart(8, "0")}`)));
  assert.equal(seen.size, PROJECT_TINTS.length, "every colour is used");
});

/** WCAG relative luminance of #RRGGBB. */
function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}

test("every tint keeps white letters at 4.5:1 or more", () => {
  for (const t of PROJECT_TINTS) {
    const ratio = 1.05 / (luminance(t) + 0.05);
    assert.ok(ratio >= 4.5, `${t}: ${ratio.toFixed(2)}`);
  }
});

test("no tint is the accent colour", () => {
  const tokens = readFileSync(new URL("../design/tokens.css", import.meta.url), "utf8");
  // The accent is the brand indigo family (--color-accent points at it in each theme).
  const accents = [...tokens.matchAll(/--brand-indigo[\w-]*:\s*(#[0-9a-fA-F]{6})/g)].map((m) => m[1]!.toUpperCase());
  assert.ok(accents.length > 0, "the accent tokens were found");
  for (const t of PROJECT_TINTS) assert.ok(!accents.includes(t.toUpperCase()), t);
});
