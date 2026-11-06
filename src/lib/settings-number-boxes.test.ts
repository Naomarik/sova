import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Every number box in the Settings dialog keeps exactly what was typed (blank, half-typed, a
 * letter): it goes red and Save waits, it never snaps back or wipes (Settings QA decision q2).
 * A `type="number"` input can't: the browser hands back "" for "1e" or "-", and the form then
 * writes "" over the text on the screen. So a Settings box is a text box with inputmode numeric.
 * Only number boxes in forms that wait for Save Changes; General → Sessions in Recent is outside.
 */
const components = join(dirname(fileURLToPath(import.meta.url)), "..", "components");

/** SettingsDialog.tsx, every component it imports, and everything under components/settings/. */
function settingsFiles(): string[] {
  const dialog = join(components, "SettingsDialog.tsx");
  const files = new Set([dialog]);
  for (const m of readFileSync(dialog, "utf8").matchAll(/from "\.\/([\w/-]+)"/g)) {
    const f = resolve(components, `${m[1]}.tsx`);
    if (existsSync(f)) files.add(f);
  }
  for (const f of readdirSync(join(components, "settings"))) if (f.endsWith(".tsx")) files.add(join(components, "settings", f));
  return [...files];
}

test("no Settings tab uses a type=number box: each keeps the typed text", () => {
  const files = settingsFiles();
  assert.ok(files.some((f) => f.endsWith("OverseerSettings.tsx")) && files.some((f) => f.endsWith("BatonSettings.tsx")), "the scan reaches the tabs");
  const found = files.filter((f) => /type=["{]?"?number"/.test(readFileSync(f, "utf8"))).map((f) => f.slice(components.length + 1));
  assert.deepEqual(found, [], "use type=\"text\" inputmode=\"numeric\" and hold the text in the draft");
});
