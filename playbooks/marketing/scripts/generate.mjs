#!/usr/bin/env node
// Renders a project's marketing system from its .sova/marketing/brand.json.
//
//   node <sova>/playbooks/marketing/scripts/generate.mjs --project <project root>
//        [--validate]   check brand.json and stop; writes nothing
//        [--dry-run]    say what would be written; writes nothing
//
// Node builtins only. Writes under <project>/.sova/marketing/ and nowhere else, and only files
// it owns: every file it writes is recorded with its hash in .sova/marketing/manifest.json, and a
// file that isn't in that manifest is never overwritten or deleted — it is reported and left
// alone. Everything is rendered in memory and checked before the first write, so an invalid
// brand renders nothing, not half a brand. Safe to re-run: unchanged output is not rewritten.
//
// Exit codes: 0 done; 1 bad arguments, invalid brand.json, or an unsafe layout (nothing
// written); 3 done, but some files were skipped because this generator does not own them.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const PLAYBOOK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATES = path.join(PLAYBOOK_DIR, "templates");
const SOVA_ROOT = path.resolve(PLAYBOOK_DIR, "..", "..");
const GENERATOR = fileURLToPath(import.meta.url);

/** The six playbooks, in the order they are reported. Each id must satisfy the catalog's id rule. */
const PLAYBOOK_IDS = ["readme", "doc-site", "demo-screenshots", "demo-video", "logos", "social"];
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const OUT = ".sova/marketing"; // always joined with "/" in reports; path.join for the filesystem
const MANIFEST = `${OUT}/manifest.json`;
const MANIFEST_TAG = "sova-marketing-generator/1";
const PLATFORMS = ["bluesky", "mastodon", "x", "linkedin", "hn", "reddit"];
const PALETTE_KEYS = ["bg", "ink", "muted", "accent", "accentInk"];
const THEMES = ["dark", "light", "system"];
const VARIANT_THEMES = ["light", "dark", "mono"];
/** What renderers use when brand.json has no visual.wordmark. They must say these are defaults. */
const WORDMARK_DEFAULT = { weight: "640", tracking: "-0.03em" };

/** WCAG 2 contrast ratio of two #rrggbb colors. */
function contrast(a, b) {
  const lum = (h) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
/** The pairs the site and the logo sheet put text on: [label, foreground, background]. */
const contrastPairs = (p) => [
  ["ink on bg", p.ink, p.bg],
  ["muted on bg", p.muted, p.bg],
  ["accent on bg (links)", p.accent, p.bg],
  ["accentInk on accent (primary action)", p.accentInk, p.accent],
];

// ---------------------------------------------------------------------------------------------
// Arguments

function fail(lines) {
  for (const l of [].concat(lines)) console.error(l);
  process.exit(1);
}

let args;
try {
  args = parseArgs({
    options: {
      project: { type: "string" },
      validate: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  }).values;
} catch (err) {
  fail([`generate.mjs: ${err.message}`, "usage: node generate.mjs --project <project root> [--validate] [--dry-run]"]);
}
if (args.help) {
  console.log("usage: node generate.mjs --project <project root> [--validate] [--dry-run]");
  process.exit(0);
}
if (!args.project) fail(["generate.mjs: --project <project root> is required", "usage: node generate.mjs --project <project root> [--validate] [--dry-run]"]);

const projectArg = path.resolve(args.project);
if (!fs.existsSync(projectArg) || !fs.statSync(projectArg).isDirectory()) fail(`generate.mjs: ${projectArg} is not a folder`);
const ROOT = fs.realpathSync(projectArg);
const abs = (rel) => path.join(ROOT, ...rel.split("/"));

// ---------------------------------------------------------------------------------------------
// brand.json

const BRAND_REL = `${OUT}/brand.json`;
if (!fs.existsSync(abs(BRAND_REL))) {
  fail([
    `generate.mjs: ${BRAND_REL} not found in ${ROOT}`,
    `Run the Marketing playbook's interview first; it writes that file (fields: ${path.join(PLAYBOOK_DIR, "brand.md")}).`,
  ]);
}
let brand;
try {
  brand = JSON.parse(fs.readFileSync(abs(BRAND_REL), "utf8"));
} catch (err) {
  fail(`generate.mjs: ${BRAND_REL} is not valid JSON: ${err.message}`);
}

/** Things validation could not check, printed with the result: never a silent pass. */
const notes = [];
const errors = validateBrand(brand);
if (errors.length) {
  fail([`generate.mjs: ${BRAND_REL} is invalid — nothing was written. ${errors.length} problem(s):`, ...errors.map((e) => `  - ${e}`), `Field rules: ${path.join(PLAYBOOK_DIR, "brand.md")}`]);
}
for (const n of notes) console.log(`note: ${n}`);
if (args.validate) {
  console.log(`${BRAND_REL} is valid (${brand.name}).`);
  process.exit(0);
}

function validateBrand(b) {
  const errs = [];
  notes.length = 0;
  const at = (p, msg) => errs.push(`${p}: ${msg}`);
  const kid = (p, k) => (p ? `${p}.${k}` : k);
  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

  /** Reports unknown and missing keys; true when `v` is an object, so its present keys can be
      checked one by one (callers guard each with `has`, so a missing key is reported once).
      `optional` keys are known but may be absent. */
  function object(v, p, keys, optional = []) {
    if (!isObj(v)) {
      at(p || "brand.json", "must be a JSON object");
      return false;
    }
    for (const k of Object.keys(v)) if (!keys.includes(k) && !optional.includes(k)) at(kid(p, k), "is not a brand.json field (typo?)");
    for (const k of keys) if (!(k in v)) at(kid(p, k), "is missing");
    return true;
  }
  const has = (v, k) => isObj(v) && k in v;
  function line(v, p, max) {
    if (typeof v !== "string") return at(p, "must be a string"), false;
    if (!v.trim()) return at(p, "must not be empty"), false;
    if (/[\r\n]/.test(v)) return at(p, "must be one line (no line breaks)"), false;
    if (max && v.length > max) return at(p, `must be at most ${max} characters (is ${v.length})`), false;
    return true;
  }
  function text(v, p, minWords, maxWords) {
    if (typeof v !== "string") return at(p, "must be a string"), false;
    if (!v.trim()) return at(p, "must not be empty"), false;
    const words = v.trim().split(/\s+/).length;
    if (minWords && words < minWords) return at(p, `must be at least ${minWords} words (is ${words})`), false;
    if (maxWords && words > maxWords) return at(p, `must be at most ${maxWords} words (is ${words})`), false;
    return true;
  }
  function list(v, p, min, max, item) {
    if (!Array.isArray(v)) return at(p, "must be a list"), false;
    if (v.length < min) return at(p, `must have at least ${min} item(s) (has ${v.length})`), false;
    if (max !== undefined && v.length > max) return at(p, `must have at most ${max} items (has ${v.length})`), false;
    v.forEach((x, i) => item(x, `${p}[${i}]`));
    const seen = new Set();
    v.forEach((x, i) => {
      if (typeof x !== "string") return;
      const key = x.trim().toLowerCase();
      if (seen.has(key)) at(`${p}[${i}]`, `repeats "${x}"`);
      seen.add(key);
    });
    return true;
  }
  const hex = (v, p) => (typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v) ? true : (at(p, `must be a #rrggbb color (is ${JSON.stringify(v)})`), false));
  const oneOf = (v, p, allowed) => (allowed.includes(v) ? true : (at(p, `must be one of ${allowed.join(", ")} (is ${JSON.stringify(v)})`), false));
  const weight = (v, p) => line(v, p) && (/^\d{3}$/.test(v) ? true : (at(p, `must be a weight like "400" (is "${v}")`), false));
  function url(v, p, nullable) {
    if (v === null && nullable) return true;
    let u;
    try {
      u = new URL(v);
    } catch {
      return at(p, `must be a full http(s) URL${nullable ? " or null" : ""} (is ${JSON.stringify(v)})`), false;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return at(p, `must be http: or https: (is ${u.protocol})`), false;
    return true;
  }
  /** A path relative to the project root that must exist and stay inside it. */
  function projectFile(v, p) {
    if (!line(v, p)) return false;
    if (path.isAbsolute(v)) return at(p, "must be relative to the project root, not absolute"), false;
    const full = path.resolve(ROOT, v);
    if (full !== ROOT && !full.startsWith(ROOT + path.sep)) return at(p, "must stay inside the project"), false;
    if (!fs.existsSync(full)) return at(p, `names ${v}, which does not exist`), false;
    return true;
  }

  if (!object(b, "", ["version", "name", "wordmark", "oneLiner", "paragraph", "audience", "notThis", "language", "voice", "visual", "mark", "project", "social", "facts"])) return errs;

  if (has(b, "version") && b.version !== 1) at("version", `must be 1 (is ${JSON.stringify(b.version)})`);
  const nameOk = has(b, "name") && line(b.name, "name", 40);
  if (has(b, "wordmark") && line(b.wordmark, "wordmark", 40) && nameOk) {
    const letters = (s) => s.replace(/\s+/g, "").toLowerCase();
    if (letters(b.wordmark) !== letters(b.name)) at("wordmark", `must be "${b.name}" in another casing, not different letters (is "${b.wordmark}")`);
  }
  if (has(b, "oneLiner") && line(b.oneLiner, "oneLiner", 120) && b.oneLiner.includes("!")) at("oneLiner", "must not contain an exclamation mark");
  if (has(b, "paragraph")) text(b.paragraph, "paragraph", 40, 120);
  if (has(b, "audience")) text(b.audience, "audience", 8);
  if (has(b, "notThis")) list(b.notThis, "notThis", 1, undefined, (x, p) => line(x, p));
  if (has(b, "language") && line(b.language, "language") && !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(b.language)) at("language", `must be a BCP 47 tag such as en-GB (is "${b.language}")`);

  if (has(b, "voice") && object(b.voice, "voice", ["pillars", "use", "avoid", "rules"])) {
    const v = b.voice;
    if (has(v, "pillars"))
      list(v.pillars, "voice.pillars", 3, 5, (x, p) => {
        if (object(x, p, ["name", "means", "prevents"])) for (const k of ["name", "means", "prevents"]) if (k in x) line(x[k], `${p}.${k}`);
      });
    if (has(v, "use")) list(v.use, "voice.use", 3, undefined, (x, p) => line(x, p));
    if (has(v, "avoid")) list(v.avoid, "voice.avoid", 3, undefined, (x, p) => line(x, p));
    if (has(v, "rules")) list(v.rules, "voice.rules", 0, undefined, (x, p) => line(x, p));
    if (Array.isArray(v.use) && Array.isArray(v.avoid)) {
      const use = new Set(v.use.filter((w) => typeof w === "string").map((w) => w.trim().toLowerCase()));
      v.avoid.forEach((w, i) => {
        if (typeof w === "string" && use.has(w.trim().toLowerCase())) at(`voice.avoid[${i}]`, `"${w}" is also in voice.use`);
      });
    }
  }

  if (has(b, "visual") && object(b.visual, "visual", ["colorway", "typography", "palette", "fonts", "designSystem", "defaultTheme"], ["weights", "wordmark", "designSystemRefs"])) {
    const v = b.visual;
    if (has(v, "colorway")) text(v.colorway, "visual.colorway", 5);
    if (has(v, "typography")) text(v.typography, "visual.typography", 5);
    /** Palette fields whose value is a valid hex: [path, hex], for the design-system cross-check. */
    const hexes = [];
    if (has(v, "palette") && object(v.palette, "visual.palette", ["light", "dark"])) {
      for (const theme of ["light", "dark"]) {
        const p = `visual.palette.${theme}`;
        if (has(v.palette, theme) && object(v.palette[theme], p, PALETTE_KEYS))
          for (const k of PALETTE_KEYS) if (k in v.palette[theme] && hex(v.palette[theme][k], `${p}.${k}`)) hexes.push([`${p}.${k}`, v.palette[theme][k]]);
      }
    }
    if (has(v, "defaultTheme")) oneOf(v.defaultTheme, "visual.defaultTheme", THEMES);
    if (has(v, "weights")) list(v.weights, "visual.weights", 1, undefined, (x, p) => weight(x, p));
    if (has(v, "wordmark") && object(v.wordmark, "visual.wordmark", ["weight", "tracking"])) {
      if ("weight" in v.wordmark) weight(v.wordmark.weight, "visual.wordmark.weight");
      if ("tracking" in v.wordmark) line(v.wordmark.tracking, "visual.wordmark.tracking");
    }
    if (has(v, "designSystemRefs")) list(v.designSystemRefs, "visual.designSystemRefs", 1, undefined, (x, p) => projectFile(x, p));
    if (has(v, "fonts") && object(v.fonts, "visual.fonts", ["sans", "mono", "files"])) {
      const f = v.fonts;
      if (has(f, "sans")) line(f.sans, "visual.fonts.sans");
      if (has(f, "mono")) line(f.mono, "visual.fonts.mono");
      if (has(f, "files"))
        list(f.files, "visual.fonts.files", 0, undefined, (x, p) => {
          if (!object(x, p, ["family", "file", "weight"])) return;
          if ("family" in x && line(x.family, `${p}.family`) && x.family !== f.sans && x.family !== f.mono) at(`${p}.family`, `must be visual.fonts.sans or visual.fonts.mono (is "${x.family}")`);
          if ("file" in x && projectFile(x.file, `${p}.file`) && !/\.(woff2|woff|ttf|otf)$/i.test(x.file)) at(`${p}.file`, "must be a .woff2, .woff, .ttf or .otf file");
          if ("weight" in x && line(x.weight, `${p}.weight`) && !/^\d{3}( \d{3})?$/.test(x.weight)) at(`${p}.weight`, `must be a weight like "400" or a range like "100 900" (is "${x.weight}")`);
        });
    }
    if (has(v, "designSystem") && v.designSystem !== null && projectFile(v.designSystem, "visual.designSystem")) {
      // The design system is the source of truth; the palette is a copy a script can read, so
      // every value in it must be one the design system already states.
      const full = path.resolve(ROOT, v.designSystem);
      if (!fs.statSync(full).isFile()) notes.push(`visual.designSystem names a folder (${v.designSystem}), so the palette was not cross-checked against it; name the tokens file to check it.`);
      else {
        const source = fs.readFileSync(full, "utf8").toLowerCase();
        for (const [p, h] of hexes) if (!source.includes(h.toLowerCase())) at(p, `${h} does not appear in ${v.designSystem} (visual.designSystem). The palette is not a second source of truth: use a value the design system states, or change the design system first`);
      }
    }
  }

  if (has(b, "mark") && b.mark !== null) {
    if (object(b.mark, "mark", ["file", "name", "chosen"], ["variants"])) {
      const m = b.mark;
      const svg = (v, p) => projectFile(v, p) && (/\.svg$/i.test(v) ? true : (at(p, `must be an .svg file (is "${v}")`), false));
      if ("file" in m) svg(m.file, "mark.file");
      if ("variants" in m) {
        list(m.variants, "mark.variants", 1, undefined, (x, p) => {
          if (!object(x, p, ["file", "theme"])) return;
          if ("file" in x) svg(x.file, `${p}.file`);
          if ("theme" in x) oneOf(x.theme, `${p}.theme`, VARIANT_THEMES);
        });
        if (Array.isArray(m.variants)) {
          const seen = new Set();
          m.variants.forEach((x, i) => {
            if (!isObj(x) || typeof x.file !== "string") return;
            if (seen.has(x.file)) at(`mark.variants[${i}].file`, `repeats "${x.file}"`);
            seen.add(x.file);
          });
        }
      }
      if ("name" in m) line(m.name, "mark.name");
      if ("chosen" in m && (typeof m.chosen !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(m.chosen) || Number.isNaN(Date.parse(m.chosen)))) at("mark.chosen", `must be a date YYYY-MM-DD (is ${JSON.stringify(m.chosen)})`);
    }
  }

  if (has(b, "project") && object(b.project, "project", ["repo", "install", "run", "demoUrl", "demoNotes"])) {
    const p = b.project;
    if (has(p, "repo")) url(p.repo, "project.repo", true);
    if (has(p, "install")) line(p.install, "project.install");
    if (has(p, "run")) {
      if (Array.isArray(p.run)) list(p.run, "project.run", 1, undefined, (x, q) => line(x, q));
      else if (typeof p.run !== "string") at("project.run", "must be a command line or a list of command lines");
      else line(p.run, "project.run");
    }
    if (has(p, "demoUrl")) url(p.demoUrl, "project.demoUrl", false);
    if (has(p, "demoNotes") && typeof p.demoNotes !== "string") at("project.demoNotes", 'must be a string ("" if there is nothing to add)');
  }

  if (has(b, "social") && object(b.social, "social", ["audience", "platforms"])) {
    if (has(b.social, "audience")) text(b.social.audience, "social.audience", 5);
    if (has(b.social, "platforms"))
      list(b.social.platforms, "social.platforms", 0, undefined, (x, p) => {
        if (!PLATFORMS.includes(x)) at(p, `must be one of ${PLATFORMS.join(", ")} (is ${JSON.stringify(x)})`);
      });
  }

  if (has(b, "facts") && object(b.facts, "facts", ["licence", "hosting", "siteUrl"])) {
    const f = b.facts;
    if (has(f, "licence") && line(f.licence, "facts.licence") && !/^[A-Za-z0-9.+-]+( (OR|AND|WITH) [A-Za-z0-9.+-]+)*$/.test(f.licence)) at("facts.licence", `must be an SPDX identifier such as MIT (is "${f.licence}")`);
    if (has(f, "hosting")) line(f.hosting, "facts.hosting");
    if (has(f, "siteUrl")) url(f.siteUrl, "facts.siteUrl", true);
  }
  return errs;
}

// ---------------------------------------------------------------------------------------------
// Render everything in memory

/** `{{name}}` and `{{wordmark}}` are the only placeholders; anything else in braces is a template bug. */
function render(text, where) {
  return text.replace(/\{\{\s*([^}]*?)\s*\}\}/g, (_, key) => {
    if (key === "name") return brand.name;
    if (key === "wordmark") return brand.wordmark;
    throw new Error(`template ${where} uses unknown placeholder {{${key}}}`);
  });
}

/** The same grammar as Sova's server/playbooks.ts parseFrontmatter, reduced to what we must prove. */
function frontmatter(text) {
  const lines = text.split("\n");
  if (lines[0] !== "---") return null;
  const close = lines.indexOf("---", 1);
  if (close < 0) return null;
  const fields = {};
  for (const raw of lines.slice(1, close)) {
    const m = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(raw);
    if (m) fields[m[1]] = m[2].trim();
  }
  return fields;
}

function walk(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

const GENERATED_NOTE = (source) =>
  `<!-- Generated by the Sova marketing playbook from .sova/marketing/brand.json${source ? ` and ${source}` : ""}. Edits here are replaced on the next run: change brand.json and re-run the generator (see .sova/marketing/TOOLS.md). -->`;

/** rel path (always "/"-separated, relative to the project root) → Buffer */
const outputs = new Map();
const put = (rel, content) => outputs.set(rel, Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8"));

try {
  for (const id of PLAYBOOK_IDS) {
    if (!ID_RE.test(id)) throw new Error(`playbook id "${id}" does not match ${ID_RE}`);
    const src = path.join(TEMPLATES, `${id}.md`);
    const rendered = render(fs.readFileSync(src, "utf8"), `templates/${id}.md`);
    const fields = frontmatter(rendered);
    if (!fields) throw new Error(`templates/${id}.md has no leading --- frontmatter`);
    for (const k of ["title", "description", "promptHint"]) if (!fields[k]) throw new Error(`templates/${id}.md: frontmatter ${k} is missing or empty`);
    // The note goes right after the fence, so it is the body's first line, not a frontmatter line.
    const close = rendered.indexOf("\n---\n", 3) + 5;
    put(`${OUT}/playbooks/${id}/PLAYBOOK.md`, `${rendered.slice(0, close)}\n${GENERATED_NOTE(`templates/${id}.md`)}\n${rendered.slice(close)}`);
    const siblings = path.join(TEMPLATES, id);
    if (fs.existsSync(siblings)) {
      for (const rel of walk(siblings)) {
        if (rel === "PLAYBOOK.md") throw new Error(`templates/${id}/PLAYBOOK.md would collide with the rendered playbook`);
        put(`${OUT}/playbooks/${id}/${rel}`, fs.readFileSync(path.join(siblings, ...rel.split("/"))));
      }
    }
  }
  for (const rel of walk(path.join(TEMPLATES, "_lib"))) put(`${OUT}/lib/${rel}`, fs.readFileSync(path.join(TEMPLATES, "_lib", ...rel.split("/"))));
  put(`${OUT}/TOOLS.md`, `${GENERATED_NOTE("templates/_tools.md")}\n\n${render(fs.readFileSync(path.join(TEMPLATES, "_tools.md"), "utf8"), "templates/_tools.md")}`);
} catch (err) {
  fail(`generate.mjs: ${err.message} — nothing was written.`);
}
put(`${OUT}/BRAND.md`, renderBrandBook(brand));
put(`${OUT}/local.json`, `${JSON.stringify(localFacts(), null, 2)}\n`);
put(`${OUT}/.gitignore`, "# Written by the Sova marketing generator. local.json holds this machine's absolute paths.\nlocal.json\n");

function which(bin) {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    const full = path.join(dir, bin);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch {}
  }
  return null;
}

function localFacts() {
  const skill = path.join(SOVA_ROOT, ".claude", "skills", "playwright");
  const skillOk = fs.existsSync(path.join(skill, "SKILL.md"));
  const scripts = path.join(skill, "scripts");
  return {
    note: "Machine-local facts, rewritten by the generator on every run. Gitignored: these are absolute paths on this machine.",
    generator: GENERATOR,
    marketingPlaybook: PLAYBOOK_DIR,
    playwrightSkill: skillOk ? skill : null,
    playwrightScripts: skillOk ? scripts : null,
    playwrightInstalled: skillOk && fs.existsSync(path.join(scripts, "node_modules", "playwright", "package.json")),
    ffmpeg: which("ffmpeg"),
    ffprobe: which("ffprobe"),
  };
}

function renderBrandBook(b) {
  const cell = (s) => String(s).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  const code = (s) => `\`${s}\``;
  const out = [];
  out.push(GENERATED_NOTE(""), "", `# ${b.name} — brand book`, "");
  out.push(`The brand as recorded in \`brand.json\`, for reading. Field rules: the Sova marketing playbook's \`brand.md\`.`, "");
  out.push("## One line", "", b.oneLiner, "");
  out.push("## One paragraph", "", b.paragraph, "");
  out.push("## Who it is for", "", b.audience, "");
  out.push("## What it is not", "", ...b.notThis.map((s) => `- ${s}`), "");
  out.push("## Voice", "", `Language: ${code(b.language)}. Wordmark: ${code(b.wordmark)}; in a sentence the name is **${b.name}**.`, "");
  out.push("| Pillar | In prose it means | The failure it prevents |", "|---|---|---|", ...b.voice.pillars.map((p) => `| ${cell(p.name)} | ${cell(p.means)} | ${cell(p.prevents)} |`), "");
  out.push(`**Use:** ${b.voice.use.join(", ")}.`, "", `**Avoid:** ${b.voice.avoid.join(", ")}.`, "");
  out.push("Rules every piece of prose follows:", "");
  out.push("- No superlatives and no exclamation marks in prose.", "- No claim the code at a named revision does not support.", ...b.voice.rules.map((r) => `- ${r}`), "");
  const vis = b.visual;
  out.push("## Visual direction", "", `**Color.** ${vis.colorway}`, "", `**Type.** ${vis.typography}`, "");
  out.push(`Default theme: ${code(vis.defaultTheme)}${vis.defaultTheme === "system" ? " (follows the reader's `prefers-color-scheme`)" : ""}.`, "");
  const pal = vis.palette;
  out.push("| Token | Light | Dark |", "|---|---|---|");
  for (const k of PALETTE_KEYS) out.push(`| ${k} | ${code(pal.light[k])} | ${code(pal.dark[k])} |`);
  out.push("", "Contrast (WCAG 2; text needs 4.5:1):", "", "| Pair | Light | Dark |", "|---|---|---|");
  const light = contrastPairs(pal.light);
  const dark = contrastPairs(pal.dark);
  const ratio = (r) => `${r.toFixed(2)}:1${r < 4.5 ? " — below 4.5" : ""}`;
  light.forEach(([label, fg, bg], i) => out.push(`| ${label} | ${ratio(contrast(fg, bg))} | ${ratio(contrast(dark[i][1], dark[i][2]))} |`));
  out.push("");
  out.push(`Text face: ${vis.fonts.sans}. Code face: ${vis.fonts.mono}.`);
  out.push(vis.fonts.files.length ? `Font files: ${vis.fonts.files.map((f) => `${code(f.file)} (${f.family} ${f.weight})`).join(", ")}.` : "No font files: system fonts, never a CDN.");
  out.push(vis.weights ? `Weights: ${vis.weights.join(", ")}, and no others.` : `Weights: not recorded in \`brand.json\`${vis.designSystem ? "; read them from the design system" : ""}.`);
  const wm = vis.wordmark;
  out.push(
    wm
      ? `Wordmark: ${code(b.wordmark)} at weight ${wm.weight}, tracking ${code(wm.tracking)}.`
      : `Wordmark: ${code(b.wordmark)} at weight ${WORDMARK_DEFAULT.weight}, tracking ${code(WORDMARK_DEFAULT.tracking)}. These are the generator's defaults, not a brand decision: \`brand.json\` has no \`visual.wordmark\`.`,
  );
  out.push(vis.designSystem ? `Design system: ${code(vis.designSystem)}. Every palette value above appears in it; it wins wherever the two are read differently.` : "No design system in the project yet; the palette above is the whole of it.");
  if (vis.designSystemRefs) out.push(`More of the design system: ${vis.designSystemRefs.map(code).join(", ")}.`);
  out.push("");
  out.push("## The mark", "");
  if (b.mark) {
    // BRAND.md sits in .sova/marketing/, so image links are relative to that folder.
    const rel = (file) => path.posix.relative(OUT, file);
    out.push(`![${b.name} mark: ${b.mark.name}](${rel(b.mark.file)})`, "", `**${b.mark.name}**, chosen ${b.mark.chosen}: ${code(b.mark.file)}.`, "");
    if (b.mark.variants) {
      const use = { light: "on a light background", dark: "on a dark background", mono: "one color, for where color is not allowed" };
      out.push("Fixed-color copies, for where `currentColor` has nothing to inherit (a README, a marketplace):", "", "| File | Theme | Use |", "|---|---|---|");
      for (const x of b.mark.variants) out.push(`| ${code(x.file)} | ${x.theme} | ${use[x.theme]} |`);
      out.push("");
    }
  } else out.push("Not chosen yet. The **Design the logo** playbook picks one and records it in `brand.json`.", "");
  out.push("## Running it", "", "| | |", "|---|---|");
  const run = [].concat(b.project.run).map((c) => code(cell(c)));
  out.push(`| Install | ${code(cell(b.project.install))} |`, `| Run | ${run.join("<br>")}${run.length > 1 ? ` (${run.length} processes, each in its own terminal)` : ""} |`, `| Demo URL | ${b.project.demoUrl} |`);
  out.push(`| Repository | ${b.project.repo ?? "none"} |`);
  if (b.project.demoNotes) out.push(`| Demo notes | ${cell(b.project.demoNotes)} |`);
  out.push("");
  out.push("## Social", "", b.social.audience, "", b.social.platforms.length ? `Platforms: ${b.social.platforms.join(", ")}.` : "Platforms: not decided. The **Write announcement posts** playbook asks which before it drafts anything.", "");
  out.push("## Facts", "", "| | |", "|---|---|", `| License | ${code(b.facts.licence)} |`, `| Hosting | ${cell(b.facts.hosting)} |`, `| Site URL | ${b.facts.siteUrl ?? "none yet"} |`, "");
  return out.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Safety: the output folder must be a real folder inside the project

for (const rel of [".sova", OUT]) {
  const full = abs(rel);
  if (fs.existsSync(full) && fs.lstatSync(full).isSymbolicLink()) fail(`generate.mjs: ${rel} is a symlink; refusing to write through it — nothing was written.`);
  if (fs.existsSync(full) && !fs.statSync(full).isDirectory()) fail(`generate.mjs: ${rel} exists and is not a folder — nothing was written.`);
}
const OUT_ABS = abs(OUT);

/** True when writing `rel` would land inside .sova/marketing/ once symlinks are resolved. */
function staysInside(rel) {
  let dir = path.dirname(abs(rel));
  while (!fs.existsSync(dir)) dir = path.dirname(dir);
  const real = fs.realpathSync(dir);
  const outReal = fs.existsSync(OUT_ABS) ? fs.realpathSync(OUT_ABS) : OUT_ABS;
  return real === outReal || real.startsWith(outReal + path.sep) || (!fs.existsSync(OUT_ABS) && (real === ROOT || real.startsWith(ROOT + path.sep)));
}

// ---------------------------------------------------------------------------------------------
// Manifest

let previous = {};
if (fs.existsSync(abs(MANIFEST))) {
  let m;
  try {
    m = JSON.parse(fs.readFileSync(abs(MANIFEST), "utf8"));
  } catch (err) {
    fail(`generate.mjs: ${MANIFEST} exists but is not valid JSON (${err.message}). It is not this generator's; move it aside — nothing was written.`);
  }
  if (m?.generator !== MANIFEST_TAG || typeof m.files !== "object" || m.files === null) fail(`generate.mjs: ${MANIFEST} exists but was not written by this generator. Move it aside — nothing was written.`);
  previous = m.files;
}
const sha = (buf) => `sha256:${createHash("sha256").update(buf).digest("hex")}`;

// ---------------------------------------------------------------------------------------------
// Write

const dry = args["dry-run"];
const verb = (v) => (dry ? `would ${v}` : v).padEnd(dry ? 16 : 10);
const report = [];
const owned = {};
let skipped = 0;
let changed = 0;

for (const [rel, content] of [...outputs].sort(([a], [b]) => a.localeCompare(b))) {
  const full = abs(rel);
  const exists = fs.existsSync(full) || isDanglingLink(full);
  const ours = rel in previous;
  if (exists && fs.lstatSync(full).isSymbolicLink()) {
    report.push(`${verb("skip")}${rel}  (a symlink; never written through)`);
    skipped++;
    continue;
  }
  if (exists && !ours) {
    report.push(`${verb("skip")}${rel}  (exists and this generator did not write it; left alone)`);
    skipped++;
    continue;
  }
  if (!staysInside(rel)) {
    report.push(`${verb("skip")}${rel}  (its folder resolves outside ${OUT}; left alone)`);
    skipped++;
    continue;
  }
  owned[rel] = sha(content);
  if (exists) {
    const current = fs.readFileSync(full);
    if (current.equals(content)) {
      report.push(`${verb("keep")}${rel}  (unchanged)`);
      continue;
    }
    const edited = sha(current) !== previous[rel];
    report.push(`${verb("update")}${rel}${edited ? "  (had edits made after the last run; they are replaced)" : ""}`);
  } else report.push(`${verb("write")}${rel}`);
  changed++;
  if (!dry) {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

// Files this generator wrote before and no longer produces.
for (const rel of Object.keys(previous).sort()) {
  if (rel in owned || outputs.has(rel) || rel === MANIFEST) continue;
  const full = abs(rel);
  if (!fs.existsSync(full)) continue;
  if (sha(fs.readFileSync(full)) !== previous[rel]) {
    report.push(`${verb("leave")}${rel}  (no longer generated, but edited since the last run; left alone and dropped from the manifest)`);
    continue;
  }
  report.push(`${verb("remove")}${rel}  (no longer generated)`);
  changed++;
  if (!dry) fs.rmSync(full);
}

const manifest = `${JSON.stringify(
  {
    generator: MANIFEST_TAG,
    note: "Files the Sova marketing generator owns, with their content hashes. It rewrites only these; any other file under .sova/marketing/ is yours.",
    files: Object.fromEntries(Object.entries(owned).sort(([a], [b]) => a.localeCompare(b))),
  },
  null,
  2,
)}\n`;
const manifestCurrent = fs.existsSync(abs(MANIFEST)) ? fs.readFileSync(abs(MANIFEST), "utf8") : null;
if (manifestCurrent === manifest) report.push(`${verb("keep")}${MANIFEST}  (unchanged)`);
else {
  report.push(`${verb(manifestCurrent === null ? "write" : "update")}${MANIFEST}`);
  changed++;
  if (!dry) {
    fs.mkdirSync(path.dirname(abs(MANIFEST)), { recursive: true });
    fs.writeFileSync(abs(MANIFEST), manifest);
  }
}

function isDanglingLink(full) {
  try {
    return fs.lstatSync(full).isSymbolicLink();
  } catch {
    return false;
  }
}

console.log(`${dry ? "Dry run for" : "Generated from"} ${BRAND_REL} (${brand.name}) in ${ROOT}`);
for (const line of report) console.log(`  ${line}`);
const local = JSON.parse(outputs.get(`${OUT}/local.json`).toString("utf8"));
if (!local.playwrightSkill) console.log(`warning: no Playwright skill at ${path.join(SOVA_ROOT, ".claude/skills/playwright")}; the screenshot, video, logo and site checks need it.`);
else if (!local.playwrightInstalled) console.log(`warning: Playwright is not installed in ${local.playwrightScripts}; run \`npm ci\` there before the browser steps.`);
for (const theme of ["light", "dark"])
  for (const [label, fg, bg] of contrastPairs(brand.visual.palette[theme])) {
    const r = contrast(fg, bg);
    if (r < 4.5) console.log(`warning: visual.palette.${theme}: ${label} is ${r.toFixed(2)}:1, below 4.5:1; the site check will fail on it.`);
  }
if (!local.ffmpeg || !local.ffprobe) console.log("warning: ffmpeg/ffprobe not on PATH; the demo video playbook needs them to verify a recording.");
console.log(`${dry ? "Would change" : "Changed"} ${changed} file(s); ${Object.keys(owned).length + 1} owned${skipped ? `; ${skipped} skipped — see above` : ""}.`);
console.log(`Playbooks: ${PLAYBOOK_IDS.map((id) => `${OUT}/playbooks/${id}/`).join(", ")}`);
process.exit(skipped ? 3 : 0);
