// Shared by the marketing playbooks' scripts. Node builtins only; Playwright is borrowed from
// Sova's Playwright skill (its location is in ../local.json), never installed into the project.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** .sova/marketing/ */
export const MARKETING = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** The project root: the folder holding .sova/. */
export const ROOT = path.resolve(MARKETING, "..", "..");

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`cannot read ${path.relative(ROOT, file) || file}: ${err.message}`);
  }
}

export const brand = () => readJson(path.join(MARKETING, "brand.json"));

export function local() {
  const file = path.join(MARKETING, "local.json");
  if (!fs.existsSync(file)) throw new Error(".sova/marketing/local.json is missing; re-run the generator (see .sova/marketing/TOOLS.md)");
  return readJson(file);
}

/** The playwright module from Sova's Playwright skill (or SOVA_PLAYWRIGHT). */
export function playwright() {
  const dir = process.env.SOVA_PLAYWRIGHT || local().playwrightScripts;
  if (!dir) throw new Error("no Playwright skill recorded in .sova/marketing/local.json; set SOVA_PLAYWRIGHT=<the skill's scripts dir>");
  try {
    return createRequire(path.join(dir, "package.json"))("playwright");
  } catch (err) {
    throw new Error(`cannot load playwright from ${dir} (run \`npm ci\` there): ${err.message}`);
  }
}

/** The browser YOU started with start-browser.sh, named by PW_PORT. Never a guessed port. */
export async function connect() {
  const port = process.env.PW_PORT;
  if (!port || !/^\d+$/.test(port)) throw new Error("PW_PORT must name the browser you started with start-browser.sh");
  return playwright().chromium.connectOverCDP(`http://127.0.0.1:${port}`);
}

/** Set the viewport and prove it took: over CDP a stale width reports success everywhere else. */
export async function sizeTo(page, width, height) {
  await page.setViewportSize({ width, height });
  const got = await page.evaluate(() => window.innerWidth);
  if (got !== width) throw new Error(`asked for width ${width}, the page reports innerWidth ${got}`);
}

/** The revision the project is at, and whether the tree differs from it. */
export function revision() {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).trim() !== "";
    return { sha, dirty };
  } catch {
    return { sha: null, dirty: null };
  }
}

/** `--name value` flags; anything unrecognised is an error, so a typo can't pass silently. */
export function flags(spec) {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z-]+)$/.exec(argv[i]);
    if (!m || !(m[1] in spec)) throw new Error(`unknown argument ${argv[i]}; expected ${Object.keys(spec).map((k) => `--${k}`).join(", ")}`);
    if (spec[m[1]] === "boolean") out[m[1]] = true;
    else {
      if (argv[i + 1] === undefined) throw new Error(`--${m[1]} needs a value`);
      out[m[1]] = argv[++i];
    }
  }
  return out;
}

/** Run main, print a one-line error and exit 1 on failure. */
export function run(main) {
  main().catch((err) => {
    console.error(`error: ${err.message}`);
    process.exit(1);
  });
}
