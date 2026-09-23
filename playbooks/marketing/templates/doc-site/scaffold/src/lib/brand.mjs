// brand.json, read at build time: the only place the site learns the brand. Paths resolve from
// the site folder (npm runs every script there), not import.meta.url, which Vite rewrites when
// it bundles this module.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SITE = process.cwd();
export const brand = JSON.parse(fs.readFileSync(path.join(SITE, "..", "brand.json"), "utf8"));

/** "dark" or "light" pins the theme with <html data-theme>; "system" follows prefers-color-scheme. */
export const defaultTheme = brand.visual.defaultTheme;
if (!["dark", "light", "system"].includes(defaultTheme)) throw new Error(`brand.json visual.defaultTheme is ${JSON.stringify(defaultTheme)}; expected "dark", "light" or "system"`);

/** One theme's colours, never mixed across themes: accent is that theme's links and fill, and
 *  accentInk is the ink for text sitting on that theme's accent. */
export const colours = (scheme) => brand.visual.palette[scheme];

// The wordmark's weight and tracking; 640 and -0.03em are this scaffold's defaults, used only
// when brand.json has no visual.wordmark.
export const wordmark = { weight: String(brand.visual.wordmark?.weight ?? "640"), tracking: brand.visual.wordmark?.tracking ?? "-0.03em" };

/** The allowed weights (strings), or null when brand.json doesn't restrict them. */
export const allowedWeights = brand.visual.weights?.map(String) ?? null;

// Text and emphasis take the allowed weight nearest 400 and 600; with no list, 400 and 600.
const nearest = (want) => (allowedWeights ? allowedWeights.reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a)) : String(want));
export const weights = { body: nearest(400), strong: nearest(600), wordmark: wordmark.weight };
if (allowedWeights && !allowedWeights.includes(wordmark.weight))
  throw new Error(`the wordmark weight ${wordmark.weight}${brand.visual.wordmark ? "" : " (the default; brand.json has no visual.wordmark)"} is not in visual.weights [${allowedWeights.join(", ")}]`);

/** The mark's SVG, inlined in the header so a currentColor mark takes the text's colour in
 *  either theme (inside an <img> currentColor has nothing to inherit and draws black). */
export function markSvg() {
  if (!brand.mark) return null;
  const svg = fs.readFileSync(path.join(SITE, "..", "..", "..", brand.mark.file), "utf8").replace(/<\?xml[^>]*>|<!DOCTYPE[^>]*>|<!--[\s\S]*?-->/g, "").trim();
  return svg.replace(/^<svg\b/, '<svg class="mark" aria-hidden="true" focusable="false"');
}

/** Favicons: an <img>-like use, so the fixed-colour variants apply. The icon sits on the
 *  browser's tab strip, which follows the browser's scheme, not the page's theme. */
export function favicons() {
  if (!brand.mark) return [];
  const has = (t) => (brand.mark.variants ?? []).some((v) => v.theme === t);
  if (has("light") && has("dark"))
    return [
      { href: "brand/mark-light.svg", media: "(prefers-color-scheme: light)" },
      { href: "brand/mark-dark.svg", media: "(prefers-color-scheme: dark)" },
    ];
  return [{ href: has("mono") ? "brand/mark-mono.svg" : "brand/mark.svg" }];
}

/** project.run is one line or a list of lines. */
export const runLines = [].concat(brand.project.run);

/** The project's revision when the site was built: the footer names it. */
export function builtAt() {
  const date = new Date().toISOString().slice(0, 10);
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: SITE, encoding: "utf8" }).trim();
    return { sha, date };
  } catch {
    return { sha: null, date };
  }
}

/** Screenshots captured by the demo-screenshots playbook, as synced into public/brand/. */
export function screenshots() {
  const file = path.join(SITE, "public", "brand", "screenshots", "manifest.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).shots : [];
}
