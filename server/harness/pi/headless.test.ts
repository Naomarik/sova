// Run: pnpm test -- server/harness/pi/headless.test.ts. The stand-ins for pi's terminal drawing code
// (§app.chat-processes/no-terminal-drawing, quirk P27): which of the pinned pi's modules they replace,
// that a replaced module keeps its export names, and that a stand-in takes whatever drawing code does to
// it (construct, extend, call, read, iterate, print, await) quietly, recording each call. The plugin
// itself is never installed here (it is process-wide): a fake register catches what it would answer.
// headless-files.json is the snapshot of every file in the folders the stand-ins reach into (pi-tui's
// dist/, pi's dist/modes/interactive/ and dist/utils/, marked's lib/), each marked stand-in or kept: a pi
// that adds, drops or moves a file there fails here until a person classifies it (and changes
// STANDIN_FILTER to match). PI_PACKAGE_DIR=<a pi-coding-agent dir> checks another pi (a pin bump);
// SOVA_HEADLESS_FILES_OUT=<absolute path> writes the snapshot the filter gives today, for review.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, test } from "node:test";
import { STANDIN_FILTER, installHeadless, standInCalls, standInSource } from "./headless";
import { packageFrom } from "./own-code";
import { piPackageDir } from "./testing/load-pi";

const piDir = piPackageDir;
const tuiDir = packageFrom(piDir, "@earendil-works/pi-tui")!;
const markedDir = packageFrom(tuiDir, "marked")!;
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

type Mark = "stand-in" | "kept";
interface Snapshot {
  versions: Record<string, string>;
  files: Record<string, Mark>;
}
/** The folders the stand-ins reach into: snapshot key prefix, real folder, and the path tail the filter sees. */
const FOLDERS = [
  { key: "pi-tui/dist", dir: join(tuiDir, "dist"), tail: "/@earendil-works/pi-tui/dist" },
  { key: "pi-coding-agent/dist/modes/interactive", dir: join(piDir, "dist", "modes", "interactive"), tail: "/@earendil-works/pi-coding-agent/dist/modes/interactive" },
  { key: "pi-coding-agent/dist/utils", dir: join(piDir, "dist", "utils"), tail: "/@earendil-works/pi-coding-agent/dist/utils" },
  { key: "marked/lib", dir: join(markedDir, "lib"), tail: "/marked/lib" },
];
/** Every file of those folders (source maps and type declarations aside, which never load), as the filter marks it today. */
function filesNow(): Record<string, Mark> {
  const all = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? all(join(d, e.name)) : /\.(?:map|d\.ts)$/.test(e.name) ? [] : [join(d, e.name)]));
  const out: Record<string, Mark> = {};
  for (const f of FOLDERS) for (const file of all(f.dir).sort()) {
    const rel = relative(f.dir, file);
    out[`${f.key}/${rel}`] = STANDIN_FILTER.test(`${f.tail}/${rel}`) ? "stand-in" : "kept";
  }
  return out;
}
const version = (dir: string) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version as string;

test("every file where the stand-ins reach is one the snapshot classifies, and the filter treats it as classified", () => {
  const now = filesNow();
  const out = process.env.SOVA_HEADLESS_FILES_OUT;
  if (out) writeFileSync(out, `${JSON.stringify({ versions: { "pi-coding-agent": version(piDir), "pi-tui": version(tuiDir), marked: version(markedDir) }, files: now }, null, 2)}\n`);
  const snap = JSON.parse(readFileSync(join(import.meta.dirname, "headless-files.json"), "utf8")) as Snapshot;
  const triage = `(pi ${version(piDir)}, pi-tui ${version(tuiDir)}, marked ${version(markedDir)}; the snapshot is of ${JSON.stringify(snap.versions)}): classify it in server/harness/pi/headless-files.json and make STANDIN_FILTER agree (QUIRKS.md P27)`;
  assert.deepEqual(Object.keys(now).filter((k) => !(k in snap.files)), [], `a file the snapshot doesn't know ${triage}`);
  assert.deepEqual(Object.keys(snap.files).filter((k) => !(k in now)), [], `a snapshot file that is gone or moved ${triage}`);
  assert.deepEqual(Object.keys(now).filter((k) => now[k] !== snap.files[k]).map((k) => `${k}: filter says ${now[k]}, snapshot ${snap.files[k]}`), [], `the filter and the snapshot disagree ${triage}`);
  // The snapshot itself: pi-tui's text, key and colour helpers and pi's theme are kept.
  for (const k of ["utils.js", "keys.js", "keybindings.js", "fuzzy.js", "colors.js", "terminal-image.js", "index.js"]) assert.equal(snap.files[`pi-tui/dist/${k}`], "kept", k);
  for (const k of Object.keys(snap.files).filter((k) => k.includes("/modes/interactive/theme/"))) assert.equal(snap.files[k], "kept", k);
  for (const k of ["pi-tui/dist/tui.js", "pi-tui/dist/components/text.js", "marked/lib/marked.esm.js", "pi-coding-agent/dist/modes/interactive/interactive-mode.js", "pi-coding-agent/dist/utils/syntax-highlight.js"]) assert.equal(snap.files[k], "stand-in", k);
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
  const warns: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => void warns.push(a.join(" "));
  after(() => void (console.warn = warn));
  const p = new Panel();
  assert.deepEqual(warns, [], "constructing is quiet");
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
  console.warn = warn;
  assert.equal(warns.length, 1, `one warning, for the first call that isn't a construct: ${warns.join(" | ")}`);
  assert.match(warns[0]!, /drawing code was called in this chat: Widget#render\(\)/);
  const calls = standInCalls();
  for (const c of ["new Widget", "Widget#render()", "Widget#render().join()", "hint()", "default()"]) assert.ok(calls.has(c), `${c} recorded: ${[...calls.keys()].join(", ")}`);
  assert.equal(calls.get("hint()"), 3);
  const logged = readFileSync(log, "utf8").split("\n");
  assert.ok(logged.includes("call new Widget") && logged.includes("call hint()"), "each new kind of call logged once");
  assert.equal(logged.filter((l) => l === "call hint()").length, 1);
});
