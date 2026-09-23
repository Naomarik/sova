// Builds one self-contained comparison sheet for a round of logo candidates.
//
//   node .sova/marketing/playbooks/logos/build-sheet.mjs --round .sova/marketing/assets/logos/round-1
//
// The round folder holds candidates.json (see candidates.example.json beside this script) and
// exactly one <slug>.svg per candidate, nothing more. Each SVG is checked before the sheet is
// written: a square viewBox "0 0 <grid> <grid>", a name a screen reader can read (a <title> or
// an aria-label on the <svg>), fills and strokes only currentColor or none, and no id, mask,
// clipPath, use, image, foreignObject, script, style or url() — so a mark can be inlined anywhere
// and recoloured by its host. The sheet (comparison.html, in the round folder) embeds the SVGs,
// the brand's colours and its local font files as data: URLs: it opens from disk with no network
// and no neighbouring files. check-sheet.mjs then renders and asserts it.
//
// Brand values come from brand.json, never from this file: the palette, the fonts, the lockup's
// weight and tracking (visual.wordmark) and the weights the sheet may use (visual.weights). Where
// brand.json leaves one out, typeSettings() below falls back to a stated default and reports it,
// on the console and on the sheet. The pixel sizes in the CSS (72px hero, 16/24/32px rows, the
// sheet's own text sizes and spacing) are the sheet's layout, not the brand's.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brand, flags, ROOT, run } from "../../lib/pw.mjs";

const SIZES = [16, 24, 32];
/** Used only when brand.json has no visual.wordmark (or leaves out a key), and always reported. */
export const DEFAULT_WORDMARK = { weight: "640", tracking: "-0.03em" };
/** The sheet's text and heading weights when brand.json has no visual.weights: CSS's own normal and bold. */
const DEFAULT_TEXT_WEIGHT = "400";
const DEFAULT_HEADING_WEIGHT = "700";
const CANDIDATE_KEYS = ["slug", "name", "idea", "tradeoff", "source", "changes"];
const MIME = { ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".otf": "font/otf", ".svg": "image/svg+xml", ".png": "image/png" };
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const dataUrl = (file) => `data:${MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream"};base64,${fs.readFileSync(file).toString("base64")}`;

export function readRound(dir) {
  const file = path.join(dir, "candidates.json");
  if (!fs.existsSync(file)) throw new Error(`no candidates.json in ${dir}`);
  const round = JSON.parse(fs.readFileSync(file, "utf8"));
  const errs = [];
  for (const k of Object.keys(round)) if (!["round", "grid", "brief", "candidates"].includes(k)) errs.push(`${k}: not a candidates.json field`);
  if (!Number.isInteger(round.round) || round.round < 1) errs.push("round: must be a positive integer");
  if (!Number.isInteger(round.grid) || round.grid < 16) errs.push("grid: must be an integer of at least 16 (the viewBox is 0 0 grid grid)");
  if (typeof round.brief !== "string" || !round.brief.trim()) errs.push("brief: must be a sentence");
  if (!Array.isArray(round.candidates) || !round.candidates.length) errs.push("candidates: must be a non-empty list");
  const slugs = new Set();
  (round.candidates ?? []).forEach((c, i) => {
    for (const k of Object.keys(c)) if (!CANDIDATE_KEYS.includes(k)) errs.push(`candidates[${i}].${k}: not a candidate field`);
    for (const k of ["slug", "name", "idea", "tradeoff"]) if (typeof c[k] !== "string" || !c[k].trim()) errs.push(`candidates[${i}].${k}: is missing or empty`);
    // An imported mark says where it came from and what was changed to meet the rules.
    if (("source" in c) !== ("changes" in c)) errs.push(`candidates[${i}]: "source" and "changes" go together (an imported mark names its original and what was changed, or "none")`);
    if ("source" in c) {
      if (typeof c.source !== "string" || !c.source.trim() || path.isAbsolute(c.source)) errs.push(`candidates[${i}].source: the original's path, relative to the project root`);
      else if (!fs.existsSync(path.join(ROOT, c.source))) errs.push(`candidates[${i}].source: ${c.source} does not exist`);
      if (typeof c.changes !== "string" || !c.changes.trim()) errs.push(`candidates[${i}].changes: what was changed to meet the rules, or "none"`);
    }
    if (typeof c.slug === "string" && !/^[a-z0-9][a-z0-9-]*$/.test(c.slug)) errs.push(`candidates[${i}].slug: lowercase letters, digits and hyphens only`);
    if (slugs.has(c.slug)) errs.push(`candidates[${i}].slug: repeats ${c.slug}`);
    slugs.add(c.slug);
  });
  // Exactly the candidates, no more: a stray or missing SVG means the sheet shows a different set.
  const svgs = fs.readdirSync(dir).filter((f) => f.endsWith(".svg")).map((f) => f.slice(0, -4));
  for (const s of svgs) if (!slugs.has(s)) errs.push(`${s}.svg is in the round folder but not in candidates.json`);
  for (const s of slugs) if (!svgs.includes(s)) errs.push(`${s}.svg is listed in candidates.json but missing`);
  if (errs.length) throw new Error(`${path.relative(ROOT, file)}:\n  - ${errs.join("\n  - ")}`);
  return round;
}

export function checkSvg(src, grid, name) {
  const errs = [];
  const root = /<svg\b[^>]*>/i.exec(src)?.[0];
  if (!root) return [`${name}: no <svg> element`];
  const viewBox = /\sviewBox="([^"]*)"/.exec(root)?.[1];
  if (viewBox?.trim().split(/[\s,]+/).join(" ") !== `0 0 ${grid} ${grid}`) errs.push(`${name}: viewBox must be "0 0 ${grid} ${grid}" (is ${viewBox === undefined ? "missing" : `"${viewBox}"`})`);
  if (!/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(root)) errs.push(`${name}: the <svg> needs xmlns="http://www.w3.org/2000/svg"`);
  // What matters is a name a screen reader can read when the mark is used on its own; either
  // form gives one, so either passes.
  if (!/<title>\s*[^<\s][^<]*<\/title>/.test(src) && !/\saria-label="\s*[^"\s][^"]*"/.test(root))
    errs.push(`${name}: needs a name a screen reader can read: a <title> inside the <svg> or an aria-label on it`);
  if (/\sid="/i.test(src)) errs.push(`${name}: no id attributes (two inlined marks would collide)`);
  for (const tag of ["mask", "clipPath", "use", "image", "foreignObject", "script", "style", "defs", "linearGradient", "radialGradient", "filter", "pattern"])
    if (new RegExp(`<${tag}\\b`, "i").test(src)) errs.push(`${name}: no <${tag}>`);
  if (/url\(|\shref=|xlink:href/i.test(src)) errs.push(`${name}: no url() or href: a mark refers to nothing outside itself`);
  for (const m of src.matchAll(/\s(fill|stroke)="([^"]*)"/g)) if (!["currentColor", "none"].includes(m[2])) errs.push(`${name}: ${m[1]}="${m[2]}" — use currentColor or none so the host sets the colour`);
  if (/\sstyle="[^"]*(fill|stroke)\s*:/i.test(src)) errs.push(`${name}: set fill/stroke as attributes, not in style=""`);
  return errs;
}

/** The lockup (visual.wordmark) and the weights the sheet may use (visual.weights), with a note
    for every value that is a default rather than the brand's, and an error for one that
    contradicts another. check-sheet.mjs uses the same function to know what to expect. */
export function typeSettings(b) {
  const v = b.visual;
  const notes = [];
  const errs = [];
  const isWeight = (w) => /^\d{1,4}$/.test(String(w)) && Number(w) >= 1 && Number(w) <= 1000;
  let weights = null;
  if (v.weights === undefined) notes.push(`visual.weights is not set: the sheet's text uses ${DEFAULT_TEXT_WEIGHT} and its headings ${DEFAULT_HEADING_WEIGHT}, CSS defaults, not the brand's`);
  else if (!Array.isArray(v.weights) || !v.weights.length || !v.weights.every(isWeight)) errs.push(`visual.weights must be a list of weights like ["400","600"] (is ${JSON.stringify(v.weights)})`);
  else weights = [...new Set(v.weights.map(String))].sort((a, c) => a - c);
  const wm = v.wordmark ?? {};
  const weight = String(wm.weight ?? DEFAULT_WORDMARK.weight);
  const tracking = String(wm.tracking ?? DEFAULT_WORDMARK.tracking);
  const unset = ["weight", "tracking"].filter((k) => wm[k] === undefined);
  if (unset.length)
    notes.push(`${v.wordmark ? `visual.wordmark has no ${unset.join(" or ")}` : "visual.wordmark is not set"}: the lockup uses ${unset.map((k) => `${k} ${DEFAULT_WORDMARK[k]}`).join(" and ")}, defaults, not the brand's`);
  if (!isWeight(weight)) errs.push(`visual.wordmark.weight must be a weight from 1 to 1000 (is ${JSON.stringify(wm.weight)})`);
  else if (weights && !weights.includes(weight)) errs.push(`the lockup's weight ${weight}${wm.weight === undefined ? " (the default)" : ""} is not one of visual.weights (${weights.join(", ")})`);
  if (!/^(normal|0|-?\d*\.?\d+em)$/.test(tracking)) errs.push(`visual.wordmark.tracking must be in em, like "-0.03em", or "normal" (is ${JSON.stringify(wm.tracking)})`);
  // A static font file covers one weight; any other is synthesised by the browser and isn't the lockup.
  const sans = v.fonts.files.filter((f) => f.family === v.fonts.sans);
  const covers = (f) => {
    const [lo, hi = lo] = String(f.weight).split(/\s+/).map(Number);
    return Number(weight) >= lo && Number(weight) <= hi;
  };
  if (sans.length && !sans.some(covers)) notes.push(`no font file for ${v.fonts.sans} covers weight ${weight} (files: ${sans.map((f) => f.weight).join(", ")}); the browser synthesises it, so the lockup is approximate`);
  const theme = v.defaultTheme ?? "light";
  if (v.defaultTheme === undefined) notes.push("visual.defaultTheme is not set: the sheet's page uses the light theme, a default");
  else if (!["light", "dark", "system"].includes(theme)) errs.push(`visual.defaultTheme must be light, dark or system (is ${JSON.stringify(theme)})`);
  if (errs.length) throw new Error(`brand.json can't drive the sheet:\n  - ${errs.join("\n  - ")}`);
  return {
    weight,
    tracking,
    weights,
    textWeight: weights ? (weights.includes("400") ? "400" : weights[0]) : DEFAULT_TEXT_WEIGHT,
    headingWeight: weights ? weights.at(-1) : DEFAULT_HEADING_WEIGHT,
    theme,
    notes,
  };
}

/** The SVG at a given CSS size: the source's own width/height are replaced, nothing else. */
const sized = (src, px) => src.replace(/<svg\b([^>]*)>/i, (_, attrs) => `<svg${attrs.replace(/\s(width|height)="[^"]*"/g, "")} width="${px}" height="${px}" aria-hidden="true" focusable="false">`);

/** A CSS file's relative url()s, inlined, so the sheet stays self-contained. */
function inlineCss(file) {
  return fs.readFileSync(file, "utf8").replace(/url\(\s*["']?([^"')]+)["']?\s*\)/g, (whole, ref) => {
    if (/^(data:|https?:|\/\/|#)/.test(ref)) return whole;
    const target = path.resolve(path.dirname(file), ref.split(/[?#]/)[0]);
    return fs.existsSync(target) ? `url("${dataUrl(target)}")` : whole; // left as-is: check-sheet counts it as a request
  });
}

// Only when run directly: check-sheet.mjs imports readRound from here and must not rebuild.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) run(async () => {
  const opts = flags({ round: "string" });
  if (!opts.round) throw new Error("--round <folder> is required, e.g. .sova/marketing/assets/logos/round-1");
  const dir = path.resolve(opts.round);
  const round = readRound(dir);
  const b = brand();
  const sources = round.candidates.map((c) => ({ ...c, svg: fs.readFileSync(path.join(dir, `${c.slug}.svg`), "utf8").trim() }));
  const svgErrs = sources.flatMap((c) => checkSvg(c.svg, round.grid, `${c.slug}.svg`));
  if (svgErrs.length) throw new Error(`candidates that can't ship as marks:\n  - ${svgErrs.join("\n  - ")}`);

  const { palette, fonts } = b.visual;
  const type = typeSettings(b);
  const faces = fonts.files.map((f) => `@font-face{font-family:${JSON.stringify(f.family)};src:url("${dataUrl(path.join(ROOT, f.file))}");font-weight:${f.weight}}`).join("");
  const system = b.visual.designSystem && b.visual.designSystem.endsWith(".css") ? inlineCss(path.join(ROOT, b.visual.designSystem)) : "";
  const theme = (t) => `--bg:${palette[t].bg};--ink:${palette[t].ink};--muted:${palette[t].muted};--accent:${palette[t].accent};--accent-ink:${palette[t].accentInk}`;
  // The page itself follows visual.defaultTheme; each card still shows both themes side by side.
  const page = type.theme === "dark" ? theme("dark") : theme("light");
  const sans = `${JSON.stringify(fonts.sans)},system-ui,sans-serif`;
  const css = `${faces}
*{box-sizing:border-box}
:root{${page}}
${type.theme === "system" ? `@media (prefers-color-scheme:dark){:root{${theme("dark")}}}` : ""}
body{margin:0;padding:32px;background:var(--bg);color:var(--ink);font:${type.textWeight} 14.5px/1.55 ${sans}}
main{max-width:1216px;margin:auto}
h1{font-size:36px;line-height:1.1;font-weight:${type.headingWeight};margin:8px 0 12px}
h2{font-size:20px;line-height:1.25;font-weight:${type.headingWeight};margin:0}
.eyebrow{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
.intro{max-width:78ch;margin:0 0 24px;color:var(--muted)}
.weights{display:flex;flex-wrap:wrap;gap:8px 32px;align-items:baseline;margin:0 0 24px}
.weights figure{align-items:flex-start}
.wrap{container-type:inline-size}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px}
.card{padding:24px;border:1px solid color-mix(in srgb,var(--muted) 35%,transparent);border-radius:12px;min-width:0}
.heading{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:16px}
.panels{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.sample{background:var(--bg);color:var(--ink);padding:20px 16px;border-radius:8px}
.sample.light{${theme("light")}}.sample.dark{${theme("dark")}}
.sample .eyebrow{color:var(--muted)}
.hero{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:12px;min-height:120px}
.word{white-space:nowrap;font-size:32px;font-weight:${type.weight};letter-spacing:${type.tracking};font-family:${sans}}
.sizes{display:flex;flex-wrap:wrap;align-items:end;justify-content:center;gap:16px 20px}
figure{margin:0;display:flex;flex-direction:column;align-items:center;gap:6px}
figcaption{font-size:11px;color:var(--muted)}
.accent{color:var(--accent)}
.tile{background:var(--accent);color:var(--accent-ink);padding:6px;border-radius:8px}
svg{display:block;flex:none}
.idea{margin:16px 0 8px}.tradeoff,.source{font-size:12.5px;color:var(--muted);margin:0}.source{margin-top:8px}
.file{font:${type.textWeight} 11px/1.3 ${JSON.stringify(fonts.mono)},ui-monospace,monospace;color:var(--muted);margin-top:12px}
footer{margin-top:24px;color:var(--muted);font-size:12.5px}
footer p{margin:0 0 6px}
@container (max-width:850px){.grid{grid-template-columns:1fr}}
@container (max-width:450px){.panels{grid-template-columns:1fr}.heading{display:block}.card{padding:16px}}`;

  const cards = sources.map((c, i) => {
    const panels = ["light", "dark"].map((t) => {
      const sizes = SIZES.map((px) => `<figure>${sized(c.svg, px)}<figcaption>${px}px</figcaption></figure>`).join("");
      return `<div class="sample ${t}" data-theme="${t}"><div class="eyebrow">${t}</div><div class="hero">${sized(c.svg, 72)}<span class="word">${esc(b.wordmark)}</span></div><div class="sizes">${sizes}<figure class="accent">${sized(c.svg, 32)}<figcaption>accent</figcaption></figure><figure><div class="tile">${sized(c.svg, 32)}</div><figcaption>on accent</figcaption></figure></div></div>`;
    });
    const source = c.source ? `<p class="source">Imported from <code>${esc(c.source)}</code>. Changed: ${esc(c.changes)}</p>` : "";
    return `<section class="card" data-slug="${esc(c.slug)}"><div class="heading"><h2>${String(i + 1).padStart(2, "0")} / ${esc(c.name)}</h2></div><div class="panels">${panels.join("")}</div><p class="idea">${esc(c.idea)}</p><p class="tradeoff">${esc(c.tradeoff)}</p>${source}<div class="file">${esc(c.slug)}.svg</div></section>`;
  });
  // The wordmark at every weight the brand allows, so the lockup's weight is chosen by eye.
  const strip = type.weights
    ? `<div class="weights">${type.weights.map((w) => `<figure><span class="word" style="font-weight:${w}">${esc(b.wordmark)}</span><figcaption>${w}${w === type.weight ? " · the lockup" : ""}</figcaption></figure>`).join("")}</div>`
    : "";
  const fontNote = fonts.files.length ? `Wordmark: ${esc(fonts.sans)}, embedded from the project's font files.` : `Wordmark: ${esc(fonts.sans)} is not embedded (brand.json has no font files), so it renders in a system fallback and is not the final lockup.`;
  const lockup = `Lockup: weight ${type.weight}, tracking ${type.tracking}${b.visual.wordmark ? ", from visual.wordmark" : ""}.${type.weights ? ` Weights allowed by visual.weights: ${type.weights.join(", ")}.` : ""}`;
  const defaults = type.notes.map((n) => `<p class="default">Default: ${esc(n)}.</p>`).join("");
  const html = `<!doctype html><html lang="${esc(b.language)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(b.name)} · logo round ${round.round}</title>${system ? `<style>${system}</style>` : ""}<style>${css}</style></head><body><main><div class="eyebrow">${esc(b.name)} / logo round ${round.round}</div><h1>${round.candidates.length} candidates</h1><p class="intro">${esc(round.brief)}</p>${strip}<div class="wrap"><div class="grid">${cards.join("")}</div></div><footer><p>Exploration, not a trademark search. One colour on a ${round.grid}-unit grid; the 16 / 24 / 32px rows are actual CSS sizes. ${fontNote} ${esc(lockup)} No masks, ids, external assets or network requests.</p>${defaults}</footer></main></body></html>`;
  const out = path.join(dir, "comparison.html");
  fs.writeFileSync(out, html);
  console.log(`checked ${sources.length} SVG(s) against a ${round.grid}-unit grid; wrote ${path.relative(process.cwd(), out)} (${html.length} bytes, self-contained)`);
  console.log(lockup);
  for (const n of type.notes) console.log(`default: ${n}`);
});
