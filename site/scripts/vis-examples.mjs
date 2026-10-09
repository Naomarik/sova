// Renders the Vis docs page's examples (vis-examples/examples.mjs) with Sova's own vis code and
// writes them to src/generated/vis-examples.html: each example's `vis` block, its drawing as
// static HTML, and the vis styles scoped to `.vis-examples`. The docs page puts that file where
// vis.md has its `<!-- vis-examples -->` line. Run it after a change to an example or to the app's
// vis code or styles (`pnpm run vis-examples`); it needs the repository's root packages installed
// (`pnpm install` at the root), not the site's. The output is the same bytes on every run.
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer } from "vite";
import solid from "vite-plugin-solid";
import { EXAMPLES } from "./vis-examples/examples.mjs";

const site = resolve(import.meta.dirname, "..");
const repo = resolve(site, "..");
const vis = join(repo, "src/vis");
const out = join(site, "src/generated/vis-examples.html");
const SCOPE = ".vis-examples";
// Every copied rule starts with the scope class twice: specific enough to beat the docs page's own
// prose rules around it (`.docs-body :not(pre) > code` would otherwise restyle a code line).
const PREFIX = SCOPE + SCOPE;

// ---- Draw ----------------------------------------------------------------------------------

/**
 * The Views that lay out for their pane's width measure it in the browser (a ResizeObserver, in
 * onMount), which never runs on the server. Here they are handed the width render.tsx is drawing
 * at instead: flow's and sequence's shared hook, and chart's and matrix's starting width. Each
 * replacement must match exactly once, so a change to those lines stops the generator rather than
 * drawing at the wrong width.
 */
const WIDTH_FROM_RENDER = "globalThis.__VIS_WIDTH__";
const atWidth = {
  "src/vis/kinds/flow/width.ts": [
    /export function useWidth\(\)[^{]*\{[\s\S]*?\n\}\n/,
    `export function useWidth(): [Accessor<number>, (el: HTMLElement) => void] {\n  const width = ${WIDTH_FROM_RENDER};\n  return [() => width, () => {}];\n}\n`,
  ],
  "src/vis/kinds/chart/View.tsx": [/createSignal\(560\)/, `createSignal(${WIDTH_FROM_RENDER})`],
  "src/vis/kinds/matrix/View.tsx": [/createSignal\(560\)/, `createSignal(${WIDTH_FROM_RENDER})`],
};
const measuredWidth = {
  name: "vis-examples-width",
  enforce: "pre",
  transform(code, id) {
    const file = Object.keys(atWidth).find((f) => id.split("?")[0] === join(repo, f));
    if (!file) return null;
    const [pattern, replacement] = atWidth[file];
    const hits = code.match(new RegExp(pattern.source, "g"))?.length ?? 0;
    if (hits !== 1) throw new Error(`vis-examples: expected one width measurement in ${file}, found ${hits}`);
    return code.replace(pattern, replacement);
  },
};

const server = await createServer({
  root: repo,
  configFile: false,
  logLevel: "error",
  appType: "custom",
  cacheDir: join(site, "node_modules/.vite-vis-examples"),
  plugins: [measuredWidth, solid({ ssr: true, solid: { hydratable: false } })],
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  optimizeDeps: { noDiscovery: true, include: [] },
});
let rendered, kinds;
try {
  const icons = await server.ssrLoadModule(join(vis, "icons.ts"));
  // The app serves its icons at /icons/; the site has no such folder, so each drawing carries the
  // few it uses inline, as the share build does.
  icons.setVisIcons((name) => `data:image/svg+xml,${encodeURIComponent(readFileSync(join(repo, "public/icons", `${name}.svg`), "utf8").trim())}`);
  const mod = await server.ssrLoadModule(join(site, "scripts/vis-examples/render.tsx"));
  rendered = mod.renderExamples(EXAMPLES);
  kinds = mod.kindWords();
} finally {
  await server.close();
}
const missing = kinds.filter((k) => !rendered.some((r) => r.kind === k));
if (missing.length) throw new Error(`vis-examples: no example for ${missing.map((k) => `vis ${k}`).join(", ")}`);

// ---- Styles: the app's own, scoped ------------------------------------------------------------

/** Top-level CSS blocks: `{ prelude, body }` for a rule or block at-rule, `{ text }` for a statement. */
function blocks(css) {
  const outBlocks = [];
  let i = 0;
  const n = css.length;
  while (i < n) {
    while (i < n && /\s/.test(css[i])) i++;
    if (css.startsWith("/*", i)) {
      i = css.indexOf("*/", i) + 2;
      continue;
    }
    if (i >= n) break;
    let j = i;
    while (j < n && css[j] !== "{" && css[j] !== ";") {
      if (css.startsWith("/*", j)) j = css.indexOf("*/", j) + 2;
      else j++;
    }
    if (css[j] === ";") {
      outBlocks.push({ text: css.slice(i, j + 1).trim() });
      i = j + 1;
      continue;
    }
    let depth = 1;
    let k = j + 1;
    while (k < n && depth) {
      if (css.startsWith("/*", k)) { k = css.indexOf("*/", k) + 2; continue; }
      if (css[k] === "{") depth++;
      else if (css[k] === "}") depth--;
      k++;
    }
    outBlocks.push({ prelude: css.slice(i, j).replace(/\/\*[\s\S]*?\*\//g, "").trim(), body: css.slice(j + 1, k - 1) });
    i = k;
  }
  return outBlocks;
}

/** A selector list's selectors: its top-level commas only, never those inside `:is(…)` and the like. */
function selectors(list) {
  const out = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i] === "(") depth++;
    else if (list[i] === ")") depth--;
    else if (list[i] === "," && depth === 0) {
      out.push(list.slice(from, i));
      from = i + 1;
    }
  }
  out.push(list.slice(from));
  return out.map((s) => s.trim().replace(/\s+/g, " ")).filter(Boolean);
}

/** Each selector under SCOPE; the app's `.md` (the chat's message body) becomes SCOPE itself. */
const scopeSelector = (sel) =>
  selectors(sel)
    .map((s) => (s.startsWith(".md ") ? `${PREFIX} ${s.slice(4)}` : `${PREFIX} ${s}`))
    .join(", ");

const squeeze = (body) => body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").trim();

function scope(css) {
  return blocks(css)
    .map((b) => {
      if (b.text !== undefined) return b.text;
      if (/^@(media|container|supports)\b/.test(b.prelude)) return `${b.prelude} {\n${scope(b.body)}\n}`;
      if (/^@(keyframes|font-face)\b/.test(b.prelude)) return `${b.prelude} { ${squeeze(b.body)} }`;
      if (b.prelude.startsWith("@")) throw new Error(`vis-examples: no rule for ${b.prelude}`);
      return `${scopeSelector(b.prelude)} { ${squeeze(b.body)} }`;
    })
    .join("\n");
}

/** base.css's top-level rules whose selector list includes one of `wanted` exactly. */
function pick(css, wanted) {
  const want = new Set(wanted);
  const got = blocks(css).filter((b) => b.prelude && !b.prelude.startsWith("@") && selectors(b.prelude).some((s) => want.has(s)));
  const found = new Set(got.flatMap((b) => selectors(b.prelude)));
  const lost = wanted.filter((s) => !found.has(s));
  if (lost.length) throw new Error(`vis-examples: base.css has no rule for ${lost.join(", ")}`);
  return got.map((b) => `${b.prelude} {${b.body}}`).join("\n");
}

const kindCss = readdirSync(join(vis, "kinds"))
  .sort()
  .flatMap((k) =>
    readdirSync(join(vis, "kinds", k))
      .filter((f) => f.endsWith(".css"))
      .sort()
      .map((f) => readFileSync(join(vis, "kinds", k, f), "utf8")),
  );
const base = readFileSync(join(repo, "src/design/base.css"), "utf8");
// What the Views use from the app's own stylesheet: icons, the visually hidden word, the code
// kind's syntax colours, and the stepper's buttons.
const fromBase = pick(base, [
  ".icon", ".icon-sm", "span.icon", "i.icon", ".visually-hidden",
  ".button", ".button:disabled", ".button-sm", ".button-ghost",
  ".hljs-keyword", ".hljs-built_in", ".hljs-title", ".hljs-string", ".hljs-number", ".hljs-comment", ".hljs-params", ".hljs-addition", ".hljs-deletion", ".hljs-strong", ".hljs-emphasis",
]);
// The chat's text around a drawing, which its own rules inherit from (the docs page's prose is
// larger), and the box the frame gives an svg document (kinds/frame/srcdoc.ts: 12px, centred).
const page = `
.vis { font-size: var(--fs-body); line-height: var(--lh-body); letter-spacing: var(--ls-body); color: var(--color-ink); text-wrap: initial; }
.vis-frame-static { display: flex; justify-content: center; padding: 12px; }
.vis-frame-static > svg { display: block; width: 100%; height: auto; max-width: var(--vis-svg-max, none); }
/* A drawing laid out at both widths (render.tsx): the phone one below 560px, as the app re-lays it out. */
@container vis (max-width: 560px) { .vis-at-wide { display: none; } }
@container vis (min-width: 560.02px) { .vis-at-narrow { display: none; } }
.vis-example > * + * { margin-top: var(--space-3); }
.vis-example + .vis-example { margin-top: var(--space-7); }
.vis-example .vis { margin: var(--space-3) 0 0; }
.vis-example-note { font-size: var(--fs-caption); line-height: var(--lh-caption); color: var(--color-ink-muted); }
`;
const css = scope([readFileSync(join(vis, "vis.css"), "utf8"), ...kindCss, fromBase, page].join("\n"));

// ---- Page fragment ---------------------------------------------------------------------------

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Static means inert: a control that would act in the chat is shown, disabled. */
const inert = (html) => html.replace(/<button(?![^>]*\sdisabled)/g, "<button disabled");

/** An svg example's natural width, as the frame would cap it (srcdoc.ts: viewBox width, never scaled up). */
const svgCap = (html) =>
  html.replace(/<div class="vis-frame-static">\s*<svg viewBox="0 0 (\d+(?:\.\d+)?) /, (m, w) => m.replace('class="vis-frame-static"', `class="vis-frame-static" style="--vis-svg-max:${w}px"`));

const parts = rendered.map(({ kind, figure }) => {
  const ex = EXAMPLES.find((e) => e.kind === kind);
  const fence = "```vis " + kind + "\n" + ex.source + "\n```";
  const drawing = figure
    ? inert(svgCap(figure))
    : `<p class="vis-example-note">In the chat this block runs in a sandboxed frame, with its own Step button. This page runs no script, so here is its source only.</p>`;
  return `<section class="vis-example" id="vis-example-${kind}">
<h3><code>vis ${kind}</code></h3>
<pre><code>${esc(fence)}</code></pre>
${drawing}
</section>`;
});

const html = `<!-- Generated by site/scripts/vis-examples.mjs (pnpm run vis-examples). Don't edit by hand. -->
<div class="vis-examples">
<style>
${css}
</style>
${parts.join("\n")}
</div>
`;

const banned = ["§", "pi-config/", "server/", "src/"];
const leak = banned.find((w) => html.includes(w));
if (leak) throw new Error(`vis-examples: the output contains "${leak}", which the docs leak guard refuses`);

mkdirSync(join(site, "src/generated"), { recursive: true });
writeFileSync(out, html);
console.log(`vis-examples: ${rendered.length} examples (${rendered.filter((r) => !r.figure).map((r) => `vis ${r.kind} as source`).join(", ")}) → src/generated/vis-examples.html`);
