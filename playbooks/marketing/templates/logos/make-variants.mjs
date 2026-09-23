// Writes the fixed-colour copies of the chosen mark that a README, a registry page or an <img>
// needs: surfaces that can't set a colour, where currentColor falls back to black.
//
//   node .sova/marketing/playbooks/logos/make-variants.mjs [--mark <file.svg>] [--out <folder>]
//        [--colour ink|accent] [--mono <#rrggbb>] [--force]
//
// --mark defaults to mark.file in brand.json, wherever in the project it lives. Every
// currentColor in it becomes a fixed hex; nothing else changes. It writes <name>-light.svg (for
// a light background: visual.palette.light.<colour>) and <name>-dark.svg (for a dark background:
// visual.palette.dark.<colour>), plus <name>-mono.svg only when --mono names its colour: there is
// no brand default for a one-colour mark. --colour defaults to ink. --out defaults to
// .sova/marketing/assets/logos/. An existing file with different content is left alone unless
// --force. Prints the mark.variants entries to put in brand.json.
import fs from "node:fs";
import path from "node:path";
import { brand, flags, MARKETING, ROOT, run } from "../../lib/pw.mjs";
import { checkSvg } from "./build-sheet.mjs";

run(async () => {
  const opts = flags({ mark: "string", out: "string", colour: "string", mono: "string", force: "boolean" });
  const b = brand();
  const markRel = opts.mark ? path.relative(ROOT, path.resolve(opts.mark)) : b.mark?.file;
  if (!markRel) throw new Error("brand.json has no mark yet; pass --mark <file.svg> or record the mark first (PLAYBOOK.md step 7)");
  const markFile = path.join(ROOT, markRel);
  if (!fs.existsSync(markFile)) throw new Error(`${markRel} does not exist`);
  const colour = opts.colour ?? "ink";
  if (!["ink", "accent"].includes(colour)) throw new Error("--colour must be ink or accent");
  if (opts.mono !== undefined && !/^#[0-9a-fA-F]{6}$/.test(opts.mono)) throw new Error("--mono must be a #rrggbb colour");

  const src = fs.readFileSync(markFile, "utf8");
  if (!/currentColor/.test(src)) throw new Error(`${markRel} has no currentColor: it is already fixed-colour, so it is a variant itself, not the mark`);
  const grid = /\sviewBox="0 0 (\d+(?:\.\d+)?) \1"/.exec(src)?.[1];
  const errs = checkSvg(src, grid ?? "<grid>", path.basename(markRel));
  if (errs.length) throw new Error(`the mark breaks the rules a variant inherits:\n  - ${errs.join("\n  - ")}`);

  const out = path.resolve(opts.out ?? path.join(MARKETING, "assets", "logos"));
  fs.mkdirSync(out, { recursive: true });
  const stem = path.basename(markRel, ".svg");
  const plan = [
    ["light", b.visual.palette.light[colour], `visual.palette.light.${colour}`],
    ["dark", b.visual.palette.dark[colour], `visual.palette.dark.${colour}`],
    ...(opts.mono ? [["mono", opts.mono, "--mono"]] : []),
  ];
  const variants = [];
  for (const [theme, hex, from] of plan) {
    const file = path.join(out, `${stem}-${theme}.svg`);
    const rel = path.relative(ROOT, file).split(path.sep).join("/");
    const content = src.replace(/currentColor/g, hex);
    if (fs.existsSync(file) && fs.readFileSync(file, "utf8") !== content && !opts.force) {
      console.log(`left   ${rel}  (exists with different content; --force replaces it; not listed below)`);
      continue;
    } else {
      fs.writeFileSync(file, content);
      console.log(`wrote  ${rel}  ${hex} from ${from}, for a ${theme === "mono" ? "one-colour" : theme} surface`);
    }
    variants.push({ file: rel, theme });
  }
  console.log(`\nmark.variants for brand.json:\n${JSON.stringify(variants, null, 2)}`);
});
