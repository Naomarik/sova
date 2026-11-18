// Run: pnpm test src/lib/working-notes.test.ts
// No reply folds (§chat.markdown/working-notes): an assistant-text row with a `### Working notes`
// heading, as older replies carry, draws it as an ordinary h3 with all of its text open beneath it,
// streaming or not. Drawn with Solid's SSR build.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { renderMarkdown } from "./markdown";

// Markdown cancels its pending frame on cleanup; the server build renders with no window.
const g = globalThis as { cancelAnimationFrame?: (id: number) => void; requestAnimationFrame?: (fn: () => void) => number };
g.cancelAnimationFrame ??= () => {};
g.requestAnimationFrame ??= () => 0;

// @ts-expect-error untyped .mjs import
const { importSsr } = await import("./align-card-ssr.mjs");
const solid = await import("solid-js");
const { renderToString } = await import("solid-js/web");
const { AssistantText } = await importSsr(new URL("../components/MessageRows.tsx", import.meta.url), (s: string) => import.meta.resolve(s));

const draw = (text: string, streaming = false) =>
  renderToString(() => solid.createComponent(AssistantText as never, { text, author: "m", showHead: false, streaming } as never));

const OLD_REPLY = "Done: the export works.\n\n### Working notes\nRead `server/export.ts`.\n\nRan the export tests: 12 passed.";

test("an assistant reply with a `### Working notes` heading draws all of it open: the heading is an h3, nothing is a disclosure", () => {
  // The row draws the reply as one markdown body, streaming or not, with no fold beside it. (SSR leaves
  // that body's html to its effect, so what it holds is read from the renderer it uses, below.)
  for (const streaming of [false, true]) {
    const html = draw(OLD_REPLY, streaming);
    assert.doesNotMatch(html, /<details|<summary|disclosure|md-working-notes/, `nothing folds (streaming: ${streaming})`);
    assert.equal(html.match(/class="message-body md"/g)?.length, 1, `one markdown body (streaming: ${streaming})`);
    // The renderer draws every part of the reply, the heading as an ordinary h3, in the reply's order.
    const body = renderMarkdown(OLD_REPLY, streaming).html;
    assert.match(body, /<h3>Working notes<\/h3>/, "the heading is an ordinary h3");
    const at = (s: string) => body.indexOf(s);
    const parts = ["Done: the export works.", "<h3>Working notes</h3>", "server/export.ts", "Ran the export tests: 12 passed."];
    for (const part of parts) assert.ok(at(part) >= 0, `${JSON.stringify(part)} is drawn (streaming: ${streaming})`);
    assert.deepEqual([...parts].sort((a, b) => at(a) - at(b)), parts, "in the reply's own order");
  }
  // A heading with nothing after it is still drawn: nothing in the reply is dropped.
  assert.match(renderMarkdown("Top.\n\n### Working notes\n").html, /<h3>Working notes<\/h3>/);
});

test("the stylesheet carries no working-notes fold", () => {
  const css = readFileSync(new URL("../design/base.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /md-working-notes/);
});
