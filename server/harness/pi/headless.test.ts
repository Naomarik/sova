// Run: pnpm test -- server/harness/pi/headless.test.ts. The stand-ins for pi's terminal drawing code
// (§app.chat-processes/no-terminal-drawing, quirk P27): which of the pinned pi's modules they replace,
// that a replaced module keeps its export names, and that a stand-in takes whatever drawing code does to
// it (construct, extend, call, read, iterate, print, await) quietly, recording each call. The plugin
// itself is never installed here (it is process-wide): a fake register catches what it would answer.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { after, test } from "node:test";
import { STANDIN_FILTER, installHeadless, standInCalls, standInSource } from "./headless";
import { EXTENSION_DEPS, packageFrom } from "./own-code";

const REPO = resolve(import.meta.dirname, "../../..");
const piDir = packageFrom(join(REPO, "server"), EXTENSION_DEPS[0])!;
const tuiDir = packageFrom(piDir, "@earendil-works/pi-tui")!;
const t = realpathSync(mkdtempSync(join(tmpdir(), "headless-")));
after(() => rmSync(t, { recursive: true, force: true }));
const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".js") ? [join(d, e.name)] : []));
const matched = (dir: string, key: string) =>
  walk(join(dir, "dist"))
    .map((f) => relative(join(dir, "dist"), f))
    .filter((rel) => STANDIN_FILTER.test(`/${key}/dist/${rel}`))
    .sort();

const log = join(t, "standins.log");
let load: ((path: string) => string) | undefined;
let filter: RegExp | undefined;
installHeadless({ SOVA_STANDIN_LOG: log }, (f, l) => {
  filter = f;
  load = l;
});

test("pi-tui's drawing modules are replaced, its text, key, colour and image helpers are not", () => {
  const all = walk(join(tuiDir, "dist")).map((f) => relative(join(tuiDir, "dist"), f));
  const replaced = matched(tuiDir, "@earendil-works/pi-tui");
  const kept = all.filter((r) => !replaced.includes(r)).sort();
  assert.deepEqual(kept, ["colors.js", "fuzzy.js", "index.js", "keybindings.js", "keys.js", "native-modifiers.js", "native-module-path.js", "native-platform.js", "oklab.js", "terminal-colors.js", "terminal-image.js", "utils.js"]);
  for (const r of ["tui.js", "terminal.js", "components/text.js", "components/editor.js", "components/markdown.js"]) assert.ok(replaced.includes(r), r);
});

test("pi's terminal mode and highlighter are replaced; its theme, core, rpc mode and the rest are not", () => {
  const replaced = matched(piDir, "@earendil-works/pi-coding-agent");
  assert.ok(replaced.includes("modes/interactive/interactive-mode.js"));
  assert.ok(replaced.includes("modes/interactive/components/index.js"));
  assert.ok(replaced.includes("utils/syntax-highlight.js"));
  assert.deepEqual(
    replaced.filter((r) => !/^modes\/interactive\/(?:components\/)?[^/]+\.js$/.test(r) && r !== "utils/syntax-highlight.js"),
    [],
    "nothing else",
  );
  assert.equal(replaced.filter((r) => r.includes("/theme/")).length, 0, "the theme stays");
  assert.ok(STANDIN_FILTER.test("/x/node_modules/marked/lib/marked.esm.js"), "marked");
  assert.ok(!STANDIN_FILTER.test("/x/node_modules/highlight.js/lib/core.js"), "Sova's own highlight.js is never touched (pi's goes with its highlighter)");
});

test("a replaced module keeps every export name of the real one", () => {
  const scan = (code: string) => new (globalThis as any).Bun.Transpiler({ loader: "js" }).scan(code).exports.sort();
  for (const f of [...matched(tuiDir, "@earendil-works/pi-tui").map((r) => join(tuiDir, "dist", r)), ...matched(piDir, "@earendil-works/pi-coding-agent").map((r) => join(piDir, "dist", r))]) {
    assert.deepEqual(scan(standInSource(f)), scan(readFileSync(f, "utf8")), f);
  }
});

test("the installed loader answers a matched module with its stand-in and logs the load", () => {
  assert.equal(filter, STANDIN_FILTER);
  const text = join(tuiDir, "dist", "components", "text.js");
  assert.equal(load!(text), standInSource(text));
  assert.ok(readFileSync(log, "utf8").split("\n").includes(`load ${text}`));
});

test("a stand-in takes what drawing code does to it, quietly, and records each call", async () => {
  const real = join(t, "real.js");
  writeFileSync(real, "export class Widget {}\nexport function hint() {}\nexport const MARK = 'x';\nexport default function main() {}\nexport * from './more.js';\n");
  writeFileSync(join(t, "more.js"), "export const more = 1;\n");
  const source = standInSource(real);
  assert.match(source, /export \* from ".*\/more\.js";/, "a star re-export follows its target");
  const stand = join(t, "stand.mjs");
  writeFileSync(stand, source);
  const m = await import(stand);
  const { Widget, hint, MARK } = m;
  class Panel extends Widget {
    own = 1;
    draw() {
      return this.render(80).join("\n");
    }
  }
  const p = new Panel();
  assert.equal(p.own, 1, "a subclass keeps its own fields");
  assert.ok(p instanceof Widget);
  assert.equal(`${p.draw()}`, "", "a member's result prints as nothing");
  assert.deepEqual([...hint()], [], "iterates as empty");
  const h = hint();
  assert.equal(await h, h, "not a promise: awaiting it gives it back");
  assert.equal(JSON.stringify({ a: hint(), b: 1 }), '{"b":1}');
  assert.equal(typeof MARK, "function", "a constant is a stand-in too");
  m.default();
  assert.equal(typeof m.more, "number", "the star target here is real (the filter doesn't match it)");
  const calls = standInCalls();
  for (const c of ["new Widget", "Widget#render()", "Widget#render().join()", "hint()", "default()"]) assert.ok(calls.has(c), `${c} recorded: ${[...calls.keys()].join(", ")}`);
  assert.equal(calls.get("hint()"), 3);
  const logged = readFileSync(log, "utf8").split("\n");
  assert.ok(logged.includes("call new Widget") && logged.includes("call hint()"), "each new kind of call logged once");
  assert.equal(logged.filter((l) => l === "call hint()").length, 1);
});
