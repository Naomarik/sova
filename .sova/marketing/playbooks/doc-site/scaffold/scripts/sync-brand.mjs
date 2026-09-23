// Copies what the site shows from the project into public/brand/ before every dev and build:
// the font files, the mark and its fixed-colour variants named in brand.json, and the captured
// screenshots. public/brand/
// is gitignored; brand.json and .sova/marketing/assets/ stay the only sources.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MARKETING = path.resolve(SITE, "..");
const ROOT = path.resolve(MARKETING, "..", "..");
const OUT = path.join(SITE, "public", "brand");
const brand = JSON.parse(fs.readFileSync(path.join(MARKETING, "brand.json"), "utf8"));

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, "fonts"), { recursive: true });
const copied = [];
const copy = (from, to) => {
  if (!fs.existsSync(from)) throw new Error(`sync-brand: ${path.relative(ROOT, from)} is named but does not exist`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  copied.push(path.relative(SITE, to));
};

for (const f of brand.visual.fonts.files) copy(path.join(ROOT, f.file), path.join(OUT, "fonts", path.basename(f.file)));
if (brand.mark) {
  copy(path.join(ROOT, brand.mark.file), path.join(OUT, "mark.svg"));
  // The fixed-colour copies (theme light, dark or mono), for the favicon: a mark drawn in
  // currentColor has no colour to inherit there. The header inlines brand.mark.file instead.
  for (const v of brand.mark.variants ?? []) copy(path.join(ROOT, v.file), path.join(OUT, `mark-${v.theme}.svg`));
}
const shots = path.join(MARKETING, "assets", "screenshots");
if (fs.existsSync(path.join(shots, "manifest.json"))) {
  copy(path.join(shots, "manifest.json"), path.join(OUT, "screenshots", "manifest.json"));
  for (const s of JSON.parse(fs.readFileSync(path.join(shots, "manifest.json"), "utf8")).shots) copy(path.join(shots, s.file), path.join(OUT, "screenshots", s.file));
}
console.log(`sync-brand: ${copied.length} file(s) into public/brand/${copied.length ? `: ${copied.join(", ")}` : ""}`);
