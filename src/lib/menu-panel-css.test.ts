// Run: pnpm test -- src/lib/menu-panel-css.test.ts
// WebKit sizes an action menu's auto-height panel from its list's flex basis. The one override
// keeps that basis at content height instead of the 0 basis from `.model-menu-list { flex: 1 }`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("the action menu's direct list has a content flex basis", () => {
  const css = readFileSync(fileURLToPath(new URL("../design/base.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(css, /\.action-menu\s*>\s*\.model-menu-list\s*\{\s*flex-basis:\s*auto\s*;?\s*\}/);
});
