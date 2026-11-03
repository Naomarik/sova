// Run: pnpm test -- src/lib/focus-view.browser.test.ts (Solid's reactive build).
// Focus (§chat.transcript/focus-view): what the shell's attributes follow, and what the stylesheet
// may hide. App puts `data-focus` and `data-focus-moving` on `.app` from these two signals; the
// collapse animates only while `focusMoving` is true, so the composer growing with its text never
// does. The real screen is driven by scripts/e2e/focus-view.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
if (!import.meta.resolve("solid-js").endsWith("/dist/solid.js")) throw new Error("run with --conditions=browser (the *.browser.test.ts invocation)");

const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => void values.set(k, v) } as Storage,
});
const solid = await import("solid-js");
const { focusMoving, focusView, setFocusView, FOCUS_MOVE_MS } = await import("./ui-state");

test("the shell's attributes follow a press at once, and the moving mark clears after the collapse", async () => {
  const shell: Record<string, string | undefined> = {};
  const dispose = solid.createRoot((dispose) => {
    solid.createRenderEffect(() => {
      shell["data-focus"] = focusView() ? "on" : undefined;
      shell["data-focus-moving"] = focusMoving() ? "" : undefined;
    });
    return dispose;
  });
  try {
    assert.equal(shell["data-focus"], undefined, "off by default");
    setFocusView(true);
    assert.equal(shell["data-focus"], "on");
    assert.equal(shell["data-focus-moving"], "", "the collapse animates now");
    await new Promise((r) => setTimeout(r, FOCUS_MOVE_MS + 40));
    assert.equal(shell["data-focus-moving"], undefined, "and not after it, so typing never animates the composer");
    assert.equal(shell["data-focus"], "on", "the choice stays");
    // A second press with the same value is no change: no animation window opens.
    setFocusView(true);
    assert.equal(shell["data-focus-moving"], undefined);
    setFocusView(false);
    assert.equal(shell["data-focus"], undefined);
    assert.equal(shell["data-focus-moving"], "");
  } finally {
    dispose();
  }
});

/** A selector list split at its top-level commas only (never inside `:is(a, b)` or `:not(a, b)`). */
function splitList(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of list) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}
/** Every selector list in app.css that reads the Focus attribute. */
const css = readFileSync(new URL("../app.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const focusRules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
  .map((m) => ({ selectors: splitList(m[1]!), body: m[2]! }))
  .filter((r) => r.selectors.some((s) => s.includes("data-focus")));

test("Focus only ever changes a single-chat screen: never a workspace, a page that borrows the head, or the sessions pane", () => {
  assert.ok(focusRules.length >= 4, `found ${focusRules.length} Focus rules`);
  for (const r of focusRules)
    for (const s of r.selectors) {
      assert.match(s, /^\.app\[data-focus[^\]]*\]( \[data-focus="on"\])?|^\.app\[data-focus-moving\]/, s);
      assert.match(s, /> \.app-main(:has\(> \.transcript-wrap\))?( >|$)/, `scoped to a chat's main column: ${s}`);
      assert.doesNotMatch(s, /\.app-sidebar|\.workspace|\.spine/, s);
    }
});

test("Focus never hides the transcript, its notices or the button itself", () => {
  for (const r of focusRules) {
    if (!/display:\s*none|visibility:\s*hidden|height:\s*0/.test(r.body)) continue;
    for (const s of r.selectors) {
      // The compound the rule lands on, past any :has()/:not() argument (whose `>` is not a step).
      const target = s.replace(/:(has|not)\([^()]*\)/g, "").split(">").at(-1)!;
      assert.doesNotMatch(target, /transcript|banner|focus-toggle|jump-latest|session-head-title|app-back/, `hides ${target}`);
    }
  }
});
