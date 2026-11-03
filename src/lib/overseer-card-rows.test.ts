// The Overseer card's copy and leftover rows (§app.overseer/copies, §app.overseer/confirm), drawn by the real
// component: src/components/OverseerCards.tsx compiled as Vite compiles it (babel-preset-solid, the TypeScript
// stripped with the repo's own typescript, JSX kept), in Solid's server renderer, so the rows' markup is read as
// text with no DOM. Each .tsx under src/ is compiled the same way on import (a Bun loader plugin, this file only).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import ts from "typescript";

// babel-preset-solid and @babel/core, as vite-plugin-solid (a dev dependency) resolves them.
const req = createRequire(createRequire(import.meta.url).resolve("vite-plugin-solid"));
const babel = req("@babel/core") as { transformSync(code: string, o: Record<string, unknown>): { code?: string | null } | null };
const solidPreset = req.resolve("babel-preset-solid");

/** Bun's loader plugin, typed here (this file runs on Bun only: the runner's default). */
type LoaderBuild = { onLoad(o: { filter: RegExp }, fn: (a: { path: string }) => { contents: string; loader: "js" }): void };
const { plugin } = (globalThis as unknown as { Bun: { plugin(p: { name: string; setup(build: LoaderBuild): void }): void } }).Bun;
plugin({
  name: "solid-ssr-tsx",
  setup(build) {
    build.onLoad({ filter: /\/src\/.*\.tsx$/ }, ({ path }) => {
      const stripped = ts.transpileModule(readFileSync(path, "utf8"), {
        fileName: path,
        compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: false },
      }).outputText;
      const out = babel.transformSync(stripped, { filename: path.replace(/\.tsx$/, ".jsx"), babelrc: false, configFile: false, presets: [[solidPreset, { generate: "ssr", hydratable: false }]] });
      return { contents: out!.code!, loader: "js" };
    });
  },
});

const { createComponent } = await import("solid-js");
const { renderToString } = await import("solid-js/web");
const { DeckCard, OverseerThreadContext } = await import("../components/OverseerCards");
const { applyCardCall } = await import("../../shared/overseer-card");
type Item = import("../../shared/protocol").SovaConfirmItem;

const copy: Item = {
  kind: "copy",
  id: "demo-1a2b3c4d",
  project: "/p/demo",
  projectName: "Demo",
  slot: 2,
  branch: "sova/login-fix",
  checkout: "/p/wt/login-fix",
  state: "running",
  startedBy: { kind: "session", id: "s-1", title: "Fix the login page" },
  edits: "uncommitted",
  links: 2,
  working: true,
};
const gone: Item = { ...copy, id: "demo-5e6f7a8b", slot: 3, branch: null, checkout: "/p/wt/old-try", state: "broken", startedBy: { kind: "operator", label: "the operator" }, edits: "folder-gone", links: 0, working: false } as Item;
const leftover: Item = { kind: "leftover", id: "5174:4242:99", project: "/p/demo", projectName: "Demo", slot: 4, port: 5174, pid: 4242, start: "99", command: "node vite --port 5174", folder: "/p/wt/gone (deleted)", reason: "folder-gone" };
const session: Item = { kind: "session", id: "s-9", title: "Another", project: "demo" };

const card = (clickOnly: boolean) =>
  applyCardCall(
    [],
    { ops: [{ op: "create", title: "Clean up these copies?", choices: ["Tear Down", "Stop", "Keep"] }] },
    { now: "2026-10-26T10:00:00.000Z", prepared: { items: [session, { ...copy, default: "a" }, { ...gone, default: "a" }, { ...leftover, default: "b" }], hrefs: [], ...(clickOnly ? { clickOnly: true } : {}) } },
  ).details.card!;

/** The card as its live thread draws it (an Overseer chat's: it can be answered). */
const draw = (c: ReturnType<typeof card>) =>
  renderToString(() =>
    createComponent(OverseerThreadContext.Provider, {
      value: { answer: () => true, sent: () => undefined },
      get children() {
        return createComponent(DeckCard, { card: c });
      },
    }),
  );
const text = (html: string) => html.replace(/<!--[^>]*-->/g, "").replace(/<[^>]+>/g, " ").replace(/&#39;|&apos;/g, "'").replace(/\s+/g, " ");

test("a copy row: its branch (or folder), project, slot and state, who started it, its edits, links and session at work", () => {
  const html = draw(card(true));
  const t = text(html);
  assert.match(t, /1\. sova\/login-fix Demo · slot 2 · Running/);
  assert.match(t, /Uncommitted edits, kept in its folder/);
  assert.match(t, /2 share links/);
  assert.match(t, /Its session is working/);
  assert.match(t, /Started by Fix the login page/);
  assert.match(t, /demo-1a2b3c4d/);
  // The one with no branch reads its folder's name; a gone folder says so; the operator started it; no links, no chip.
  assert.match(t, /2\. old-try Demo · slot 3 · Broken Folder gone/);
  assert.match(t, /Started by the operator/);
  assert.doesNotMatch(t, /0 share links/);
});

test("a leftover row: its port and slot, pid, command, folder and why it is a leftover", () => {
  const t = text(draw(card(true)));
  assert.match(t, /3\. :5174 Demo · slot 4 · pid 4242/);
  assert.match(t, /node vite --port 5174/);
  assert.match(t, /\/p\/wt\/gone \(deleted\)/);
  assert.match(t, /Its folder was deleted/);
});

test("rows sit after people and before sessions, never behind the sessions' toggle; each row has its own choices", () => {
  const t = text(draw(card(true)));
  assert.ok(t.indexOf("sova/login-fix") < t.indexOf(":5174") && t.indexOf(":5174") < t.indexOf("Another"), t);
  assert.equal((t.match(/Tear Down/g) ?? []).length >= 3, true, "each of the 3 copy/leftover rows and the session row has the choice control");
});

test("a click-only card has no 'Or type your answer.'; the same card without it does", () => {
  assert.doesNotMatch(text(draw(card(true))), /Or type your answer\./);
  assert.match(text(draw(card(false))), /Or type your answer\./, "the test can tell the two apart");
});
