// Run: pnpm test -- src/lib/playbook-choice-row-dom.test.ts
// A choice row on the playbook card (§chat.playbooks/run-card), drawn with Solid's SSR build
// (src/lib/align-card-ssr.mjs): a choice worked out with the main chat has no control even on an
// editable card, says it waits for the chat until filled, then shows what the chat filled in; and no
// row ever says "Your pick".
import assert from "node:assert/strict";
import { test } from "node:test";

// @ts-expect-error untyped .mjs import
const { importSsr } = await import("./align-card-ssr.mjs");
const solid = await import("solid-js");
const { renderToString } = await import("solid-js/web");
const { ChoiceRow } = await importSsr(new URL("../components/PlaybookCard.tsx", import.meta.url), (s: string) => import.meta.resolve(s));

const choice = (extra: Record<string, unknown>) => ({ id: "c", label: "The failure to fix", type: "text", value: null, origin: "default", required: true, ask: "chat", ...extra });
const draw = (c: Record<string, unknown>, editable = true) =>
  renderToString(() => solid.createComponent(ChoiceRow as never, { choice: c, value: c.value, editable, onChange: () => {} } as never)).replace(/<!--[^>]*-->/g, "");
const CONTROL = /<(input|textarea|select)\b/;

test("a chat-filled choice waiting for the chat: no control on an editable card, the waiting line, Needed", () => {
  const html = draw(choice({}));
  assert.doesNotMatch(html, CONTROL);
  assert.match(html, /data-chat="waiting"/);
  assert.match(html, /Waiting for the chat to fill this in\./);
  assert.match(html, /class="pb-row-origin"[^>]*>Needed</);
});

test("a chat-filled choice once filled: the chat's words, read-only, From the chat", () => {
  const html = draw(choice({ value: "Cheap models pick the wrong chart for a ranking.", origin: "you" }));
  assert.doesNotMatch(html, CONTROL);
  assert.match(html, /data-chat="filled"/);
  assert.match(html, /Cheap models pick the wrong chart for a ranking\./);
  assert.match(html, /class="pb-row-origin"[^>]*>From the chat</);
});

test("an ordinary text choice keeps its box, and a value you set says nothing where Your pick was", () => {
  const html = draw(choice({ ask: "always", value: "the sea", origin: "you" }));
  assert.match(html, CONTROL);
  assert.doesNotMatch(html, /data-chat=/);
  assert.doesNotMatch(html, /Your pick/);
  assert.match(html, /class="pb-row-origin"[^>]*><\/span>/);
});
