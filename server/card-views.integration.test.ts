import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { buildView, resetCardViewsForTest, viewCode } from "./card-views";

/**
 * How Sova builds a project's card view (§chat.transcript-cards/building) and rebuilds it on save
 * (§chat.transcript-cards/redraw): Solid JSX with Sova's fixed settings, the checkout's own files and
 * installed packages only, and never anything of the project's build config, plugins or scripts.
 */

const roots: string[] = [];
after(() => {
  resetCardViewsForTest();
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function checkout(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "card-views-"));
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const VIEW = `import { createSignal } from "solid-js";
import { card, mount } from "sova:card";
import { stars } from "../../../lib/stars";
import { pad } from "left-pad-ish";
const [n, setN] = createSignal(0);
mount(() => <div class="chart"><button onClick={() => setN(n() + 1)}>{pad(stars(n()))}</button></div>);
`;

test("a view builds as Solid's compiled JSX, with its checkout's files and installed packages", async () => {
  const root = checkout({
    ".sova/cards/chart/view.tsx": VIEW,
    "lib/stars.ts": "export const stars = (n: number): string => '*'.repeat(n);",
    "node_modules/left-pad-ish/package.json": JSON.stringify({ name: "left-pad-ish", exports: { ".": { node: "./node.js", browser: "./browser.js", default: "./node.js" } } }),
    "node_modules/left-pad-ish/browser.js": "export const pad = (s) => 'the browser build' + s;",
    "node_modules/left-pad-ish/node.js": "export const pad = () => 'the node build';",
  });
  const { build, inputs } = await buildView(root, "chart");
  assert.ok(build.ok, build.ok ? "" : build.error);
  // Solid's own JSX transform: a cloned template and fine-grained inserts, never hyperscript.
  assert.ok(/template\(`<div class=chart><button>`\)/.test(build.code));
  assert.ok(/\$\$click/.test(build.code));
  assert.ok(/the browser build/.test(build.code), "a package's browser build");
  assert.ok(!/the node build/.test(build.code));
  assert.ok(!build.code.includes(root), "no path of this machine in the code");
  assert.deepEqual(inputs.map((f) => f.slice(root.length + 1)).sort(), [".sova/cards/chart/view.tsx", "lib/stars.ts"], "it watches the checkout files it read, not node_modules");
});

test("never the project's build config, plugins or scripts: a config that writes a marker when loaded is never loaded", async () => {
  const marker = (name: string) => `require("node:fs").writeFileSync(${JSON.stringify("MARKER")}.replace("MARKER", process.env.CARD_MARKER_DIR + "/" + ${JSON.stringify(name)}), "loaded");`;
  const dir = mkdtempSync(join(tmpdir(), "card-marker-"));
  roots.push(dir);
  process.env.CARD_MARKER_DIR = dir;
  const evilPlugin = `${marker("babel-plugin")} module.exports = () => ({ visitor: { Program(p) { p.unshiftContainer("body", require("@babel/core").types.expressionStatement(require("@babel/core").types.stringLiteral("EVIL-PLUGIN"))); } } });`;
  const configs: Record<string, string> = {};
  for (const at of ["", ".sova/cards/chart/"]) {
    Object.assign(configs, {
      [`${at}babel.config.js`]: `${marker(`${at}babel.config.js`)} module.exports = { plugins: ["evil"] };`,
      [`${at}babel.config.cjs`]: `${marker(`${at}babel.config.cjs`)} module.exports = { plugins: ["evil"] };`,
      [`${at}.babelrc`]: JSON.stringify({ plugins: ["evil"] }),
      [`${at}.babelrc.js`]: `${marker(`${at}.babelrc.js`)} module.exports = { plugins: ["evil"] };`,
      [`${at}vite.config.ts`]: `${marker(`${at}vite.config.ts`)} export default {};`,
      [`${at}esbuild.config.mjs`]: `${marker(`${at}esbuild.config.mjs`)}`,
      [`${at}postcss.config.js`]: `${marker(`${at}postcss.config.js`)}`,
      [`${at}.browserslistrc`]: "ie 6",
      [`${at}tsconfig.json`]: JSON.stringify({ compilerOptions: { jsx: "react", jsxFactory: "EVIL_FACTORY", paths: { "../../../lib/stars": ["./evil-stars.ts"] }, baseUrl: "." } }),
      [`${at}evil-stars.ts`]: "export const stars = () => 'EVIL-PATHS';",
    });
  }
  const root = checkout({
    ...configs,
    "package.json": JSON.stringify({ name: "p", babel: { plugins: ["evil"] }, scripts: { prebuild: "touch MARKER", postinstall: "touch MARKER", build: "touch MARKER" } }),
    "node_modules/babel-plugin-evil/package.json": JSON.stringify({ name: "babel-plugin-evil", main: "index.js" }),
    "node_modules/babel-plugin-evil/index.js": evilPlugin,
    "node_modules/left-pad-ish/package.json": JSON.stringify({ name: "left-pad-ish", main: "index.js", scripts: { postinstall: "touch MARKER" } }),
    "node_modules/left-pad-ish/index.js": "export const pad = (s) => s;",
    ".sova/cards/chart/view.tsx": VIEW,
    "lib/stars.ts": "export const stars = (n: number): string => '*'.repeat(n);",
  });
  const { build } = await buildView(root, "chart");
  assert.ok(build.ok, build.ok ? "" : build.error);
  assert.deepEqual(readdirSync(dir), [], "no config, plugin or script of the project's was loaded");
  assert.ok(!existsSync(join(root, "MARKER")));
  assert.ok(!/EVIL/.test(build.code), "no plugin, tsconfig factory or tsconfig path took part");
  assert.ok(/template\(/.test(build.code), "Solid's JSX, whatever the project's tsconfig says");
});

test("an import outside the checkout, an import that isn't there and a syntax error: the build's error, with the file and line", async () => {
  const outside = checkout({ "secret.ts": "export const s = 1;" });
  const root = checkout({
    ".sova/cards/out/view.tsx": `import { s } from ${JSON.stringify(join(outside, "secret.ts"))}; console.log(s);`,
    ".sova/cards/gone/view.tsx": `import { x } from "./nope"; console.log(x);`,
    ".sova/cards/pkg/view.tsx": `import { x } from "not-installed"; console.log(x);`,
    ".sova/cards/url/view.tsx": `import { x } from "https://example.com/x.js"; console.log(x);`,
    ".sova/cards/broken/view.tsx": `import { mount } from "sova:card";\nconst a = 1;\nmount(() => <div>{a</div>);\n`,
  });
  const err = async (name: string) => {
    const { build } = await buildView(root, name);
    assert.ok(!build.ok, `${name} built`);
    return build.error;
  };
  assert.match(await err("out"), /outside the checkout/);
  assert.match(await err("gone"), /imports "\.\/nope", which isn't there/);
  assert.match(await err("pkg"), /"not-installed", which isn't installed in the checkout/);
  assert.match(await err("url"), /can't be imported/);
  assert.match(await err("broken"), /^\.sova\/cards\/broken\/view\.tsx:3:\d+: /);
  assert.match(await err("missing"), /view\.tsx is missing/);
});

test("a save rebuilds the view and wakes a page waiting on its code, within about a second", async () => {
  const root = checkout({ ".sova/cards/live/view.tsx": `import { mount } from "sova:card"; import { v } from "./v"; mount(() => <p>{v}</p>);`, ".sova/cards/live/v.ts": "export const v = 'one';" });
  const first = await viewCode(root, "live");
  assert.ok(first.ok && /one/.test(first.code));
  const waiting = viewCode(root, "live", first.hash, 10_000);
  const t0 = Date.now();
  writeFileSync(join(root, ".sova/cards/live/v.ts"), "export const v = 'two';");
  const next = await waiting;
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
  assert.ok(next.ok && /two/.test(next.code) && next.hash !== first.hash);
  // A broken save is the build's error; the next good save builds again on its own.
  const broken = viewCode(root, "live", next.hash, 10_000);
  writeFileSync(join(root, ".sova/cards/live/view.tsx"), `import { mount } from "sova:card"; mount(() => <p>{</p>);`);
  const bad = await broken;
  assert.ok(!bad.ok);
  const healed = viewCode(root, "live", bad.hash, 10_000);
  writeFileSync(join(root, ".sova/cards/live/view.tsx"), `import { mount } from "sova:card"; mount(() => <p>three</p>);`);
  const good = await healed;
  assert.ok(good.ok && /three/.test(good.code));
  // Nothing changed: the wait ends after its time with the same build.
  const same = await viewCode(root, "live", good.hash, 200);
  assert.equal(same.hash, good.hash);
});

test("an extension's built view module and a drawing kind's view build the same way, from their own root (§app.extensions/views)", async () => {
  const { buildViewAt, viewCodeAt } = await import("./card-views");
  const dist = checkout({
    "cards/review.js": `import { card, mount } from "sova:card";\nimport { label } from "./lib.js";\nmount(() => { const p = document.createElement("p"); p.textContent = label(card.data()); return p; });\n`,
    "cards/lib.js": `export const label = (d) => "note: " + JSON.stringify(d);\n`,
    "cards/secret.js": `export const s = "KEY";\n`,
    "cards/leaks.js": `import { s } from "./secret.js";\nexport default s;\n`,
  });
  const ok = await buildViewAt(dist, "cards/review.js");
  assert.ok(ok.build.ok, ok.build.ok ? "" : ok.build.error);
  assert.ok(ok.build.ok && ok.build.code.includes("note: "));
  assert.ok(ok.build.ok && !ok.build.code.includes(dist), "no path of this machine in the code");
  // What the host refuses (an extension's backend key) is never read into a view.
  const refused = await buildViewAt(dist, "cards/leaks.js", { refuse: (f) => f.endsWith("secret.js") });
  assert.equal(refused.build.ok, false);
  assert.match(!refused.build.ok ? refused.build.error : "", /can't be read by a view/);
  // An entry outside its root is missing, never read.
  const outside = await buildViewAt(dist, "../x.js");
  assert.match(!outside.build.ok ? outside.build.error : "", /missing/);
  // A drawing kind's view in a checkout redraws on save, as a card's does.
  const proj = checkout({ ".sova/drawings/gantt/view.tsx": `import { mount } from "sova:card";\nmount(() => <svg class="one" />);\n` });
  const src = { root: proj, entry: ".sova/drawings/gantt/view.tsx" };
  const first = await viewCodeAt(src);
  assert.ok(first.ok);
  const next = viewCodeAt(src, first.hash, 5000);
  writeFileSync(join(proj, ".sova/drawings/gantt/view.tsx"), `import { mount } from "sova:card";\nmount(() => <svg class="two" />);\n`);
  const second = await next;
  assert.notEqual(second.hash, first.hash);
  assert.ok(second.ok && second.code.includes("two"));
});
