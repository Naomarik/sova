// Run: pnpm test -- src/lib/menu-panel-css.test.ts
//
// An action menu's panel (`.model-menu.action-menu`: every ⋯ menu, and the page's right-click
// menu) has no height of its own: it is a column flex box as tall as its list, up to the room it
// was given. WebKit takes that height from the list's flex basis, so a 0 basis drew the panel at
// its border and padding, 10px, with every row hidden (measured in Playwright's WebKit 26 on macOS
// and Linux; Chromium and Firefox size it from the content and never showed it). The rule's
// cascade is read here from base.css itself: every rule that reaches the list inside the panel, by
// specificity and then order, as the browser picks.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const CSS = readFileSync(fileURLToPath(new URL("../design/base.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Every innermost `selector { declarations }` block, in file order (an @media's rules included). */
function rules(css: string): { selectors: string[]; body: string; at: number }[] {
  const out: { selectors: string[]; body: string; at: number }[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(css); m; m = re.exec(css)) out.push({ selectors: m[1]!.split(",").map((s) => s.trim()), body: m[2]!, at: m.index });
  return out;
}

/**
 * Whether `sel` reaches the action menu's list, a `.model-menu-list` that is a child of the
 * panel: its last part is the list (or `*`, under `.action-menu >`), and what it asks of the
 * ancestors is only the panel's own classes. A pseudo-class or another class narrows it to some
 * other list, which this test doesn't follow.
 */
function reachesList(sel: string): boolean {
  if (/[:[]/.test(sel)) return false;
  const parts = sel.split(/\s*>\s*|\s+/).filter(Boolean);
  const last = parts.at(-1)!;
  const up = parts.slice(0, -1);
  const panelOnly = up.every((p) => p.split(".").filter(Boolean).every((c) => c === "model-menu" || c === "action-menu"));
  if (!panelOnly) return false;
  if (last === "*") return /\.action-menu\s*>\s*\*$/.test(sel);
  return last.split(".").filter(Boolean).every((c) => c === "model-menu-list") && last.startsWith(".");
}
const specificity = (sel: string) => (sel.match(/\.[\w-]+/g) ?? []).length;

/** The flex basis a declaration block sets, or undefined when it sets none. */
function basisOf(body: string): string | undefined {
  let basis: string | undefined;
  for (const decl of body.split(";")) {
    const [prop, ...rest] = decl.split(":");
    const name = prop?.trim();
    const value = rest.join(":").trim();
    if (name === "flex-basis") basis = value;
    else if (name === "flex") {
      const words = value.split(/\s+/);
      if (value === "none" || value === "auto") basis = "auto";
      else if (words.length === 1 && /^[\d.]+$/.test(words[0]!)) basis = "0%";
      else basis = words.find((w) => !/^[\d.]+$/.test(w)) ?? "0%";
    }
  }
  return basis;
}

test("an action menu's list keeps a content basis, so WebKit draws the panel as tall as its rows", () => {
  const setters = rules(CSS).flatMap((r) => {
    const basis = basisOf(r.body);
    if (basis === undefined) return [];
    return r.selectors.filter(reachesList).map((sel) => ({ sel, basis, spec: specificity(sel), at: r.at }));
  });
  assert.ok(setters.some((s) => s.sel === ".model-menu-list"), `the scan finds the list's own rule (found ${JSON.stringify(setters)})`);
  const winner = [...setters].sort((a, b) => a.spec - b.spec || a.at - b.at).at(-1)!;
  assert.ok(!/^0(%|px)?$/.test(winner.basis), `the winning rule ${winner.sel} gives the list a ${winner.basis} basis: WebKit draws the panel 10px tall (${JSON.stringify(setters)})`);
});
