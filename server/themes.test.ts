// Run: npx tsx --test server/themes.test.ts
// The acceptance gate for the theme grammar (spec/00-ground-rules.md §0) and the two folders
// server/themes.ts reads. Uses a throwaway PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never
// read or written. The shipped themes/ folder is read, never modified.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "pi-web-themes-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the module below computes its paths
const { listThemes, userThemesDir } = await import("./themes");
const { checkValue, COLOR_KEYS, CSS_PROPERTY, parseTheme, SHADOW_KEYS, TYPOGRAPHY_KEYS } = await import("../shared/theme");

const repoDir = fileURLToPath(new URL("..", import.meta.url));
const builtinDir = join(repoDir, "themes");
const userDir = userThemesDir();
mkdirSync(userDir, { recursive: true });
const dropUserTheme = (id: string, body: unknown) =>
  writeFileSync(join(userDir, `${id}.json`), typeof body === "string" ? body : JSON.stringify(body));
const clearUserThemes = () => {
  rmSync(userDir, { recursive: true, force: true });
  mkdirSync(userDir, { recursive: true });
};
/** One file's worth of parse, without going near a folder. */
const theme = (body: Record<string, unknown>) => parseTheme(JSON.stringify(body));

after(() => rmSync(agentDir, { recursive: true, force: true }));

/* --- (a) the must-reject suite ------------------------------------------- */

// Each of these has an allowed charset and would pass a check that kept only the length rule.
// What stops them is the shape: the ten-name list, or the single "(".
const MUST_REJECT: Array<[string, string, string]> = [
  ["scrim", "url(//attacker.example/x.png)", "url is not one of the ten color names"],
  ["scrim", "image-set(url(//a/x) 1x)", "not a color name, and a second ("],
  ["scrim", "image-set(//a/x.png 1x)", "one paren pair — only the name list rejects this"],
  ["accent", "red", "a named color is neither a hex nor a call"],
  ["accent", "transparent", "a keyword is neither a hex nor a call"],
  ["accent", "hwb(120 30% 40%)", "hwb is not one of the ten"],
  ["accent", "rgb(var(--x))", "a second ( — the substitution route"],
  ["bg", `#${"a".repeat(120)}`, "121 characters"],
  ["shadow-1", `0 1px 2px rgba(0, 0, 0, .5)${", 0 1px 2px rgba(0, 0, 0, .5)".repeat(7)}`, "over 200 characters"],
  ["font-body", 'Inter, url(//a/b), sans-serif', "a font stack carries no parentheses"],
];

test("(a) every mandated vector is rejected, and its key never lands in tokens", () => {
  for (const [key, value, why] of MUST_REJECT) {
    const reason = checkValue(key, value);
    assert.ok(reason, `${key}: ${value} was accepted — ${why}`);
    assert.match(reason!, new RegExp(`^${key} is `), `the reason names the key (§12): ${reason}`);
    const parsed = theme({ name: "T", extends: "dark", colors: { [key]: value }, typography: { [key]: value } });
    assert.equal(parsed.tokens[key], undefined, `${key} survived the parse`);
    assert.ok(parsed.warnings.some((w) => w.includes(key)), "the row carries its reason");
    assert.ok(parsed.error, "a value we won't emit makes the theme a broken row (§0)");
  }
  assert.equal(MUST_REJECT.length, 10);
});

test("(a) the supplementary fetch and substitution vectors are rejected too", () => {
  for (const value of [
    "-webkit-image-set(//a/b 1x)",
    "src(//attacker.example/f.woff2)",
    "var(--icon)",
    "color-mix(in oklab, rgb(var(--y)) 10%, #000)",
    "#fff; background: url(//a/b)",
    "rgb(0,0,0) , url(//a/b)",
  ])
    assert.ok(checkValue("bg", value), `bg: ${value} was accepted`);
  for (const value of ["Inter; } html { background: url(//a/b)", "Inter, image-set(//a/b 1x)", "Inter /* } */"])
    assert.ok(checkValue("font-body", value), `font-body: ${value} was accepted`);
});

test("(a) the shapes §0 allows are accepted, verbatim", () => {
  for (const value of [
    "#fff", "#ffff", "#1E1E26", "#1e1e26ff",
    "rgba(0, 0, 0, .5)", "oklch(62% 0.2 250)", "rgb(30 30 38 / 80%)",
    "color-mix(in oklab, #fff 20%, #000)", "color(display-p3 .2 .3 .4)",
  ]) {
    assert.equal(checkValue("accent", value), null, `accent: ${value} was rejected`);
    assert.equal(theme({ name: "T", colors: { accent: value } }).tokens.accent, value, "emitted verbatim");
  }
  assert.equal(checkValue("shadow-1", "inset 0 1px 2px rgba(0, 0, 0, .5)"), null);
  assert.equal(checkValue("font-mono", '"JetBrains Mono", ui-monospace, Menlo, monospace'), null);
  assert.equal(checkValue("fs-body", "14.5px"), null);
  assert.equal(checkValue("ls-display", "-.035em"), null); // a leading dot and a sign
  assert.equal(checkValue("ls-body", "0"), null); // a bare 0
  assert.equal(checkValue("lh-body", "1.55"), null);
  assert.equal(checkValue("fw-medium", "530"), null);
  for (const bad of ["14.5", "14.5rem", "14.5 px", ""]) assert.ok(checkValue("fs-body", bad), `fs-body: ${bad}`);
  for (const bad of ["0", "-1.2", "1.5em", ""]) assert.ok(checkValue("lh-body", bad), `lh-body: ${bad}`);
  for (const bad of ["99", "1000", "400.5", "bold"]) assert.ok(checkValue("fw-medium", bad), `fw-medium: ${bad}`);
});

test("(a) the key lists and the property table are §0's, and hold no focus keys", () => {
  assert.equal(COLOR_KEYS.length, 27);
  assert.equal(SHADOW_KEYS.length, 3);
  assert.equal(TYPOGRAPHY_KEYS.length, 3 + 8 + 8 + 4 + 7);
  assert.equal(CSS_PROPERTY.bg, "--color-bg");
  assert.equal(CSS_PROPERTY["ink-2"], "--color-ink-2");
  assert.equal(CSS_PROPERTY["status-success"], "--status-success");
  assert.equal(CSS_PROPERTY["diff-add-bg"], "--diff-add-bg");
  assert.equal(CSS_PROPERTY["shadow-1"], "--shadow-1");
  assert.equal(CSS_PROPERTY.scrim, "--scrim");
  assert.equal(CSS_PROPERTY["skeleton-sweep"], "--skeleton-sweep");
  assert.equal(CSS_PROPERTY["font-body"], "--font-body");
  assert.equal(CSS_PROPERTY["fs-body"], "--fs-body");
  // --focus-color and --focus-ring track the accent through var(); emitting them would freeze
  // the ring at the base theme's accent (§0).
  for (const emitted of Object.values(CSS_PROPERTY)) assert.ok(!emitted.startsWith("--focus"), emitted);
});

/* --- (b) the shipped themes ---------------------------------------------- */

test("(b) all 18 built-ins load with no error and no warning", () => {
  clearUserThemes();
  const { themes, error } = listThemes();
  assert.equal(error, undefined);
  assert.equal(themes.length, 18);
  let values = 0;
  for (const t of themes) {
    assert.deepEqual(t.warnings, [], `${t.id}: ${t.warnings.join(" | ")}`);
    assert.equal(t.error, undefined, `${t.id}: ${t.error}`);
    assert.equal(t.source, "builtin");
    assert.ok(t.name.length > 0);
    assert.ok(["dark", "light"].includes(t.base));
    assert.equal(Object.keys(t.tokens).length, 30, `${t.id} resolves the whole set`);
    values += Object.keys(JSON.parse(readFileSync(t.path, "utf8")).colors).length;
  }
  assert.equal(values, 540, "the shipped values, all of them checked");
  assert.deepEqual(themes.slice(0, 2).map((t) => t.id), ["dark", "light"]); // the two bases lead
});

/* --- (c) the zero-regression gate: dark and light ARE the token blocks ---- */

/** Every `--name: value` in one CSS block, values as authored. */
function decls(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}
const tokensCss = readFileSync(join(repoDir, "src", "design", "tokens.css"), "utf8");
const brand = decls(tokensCss); // --brand-* are unique across the file
const block = (selector: string) => {
  const at = tokensCss.indexOf(selector);
  assert.ok(at >= 0, `tokens.css has no ${selector}`);
  return decls(tokensCss.slice(at, tokensCss.indexOf("\n}", at)));
};
/** The block's own value, with one `var(--brand-…)` hop resolved: the string the browser paints. */
const flat = (map: Record<string, string>, prop: string) => {
  const v = map[prop];
  assert.ok(v !== undefined, `tokens.css block has no ${prop}`);
  const ref = /^var\((--[\w-]+)\)$/.exec(v!);
  return ref ? brand[ref[1]!]! : v!;
};

for (const [id, selector] of [["dark", ':root,\n:root[data-theme="dark"] {'], ["light", ':root[data-theme="light"] {']] as const) {
  test(`(c) ${id}.json reproduces the ${id} block in tokens.css, byte for byte`, () => {
    const css = block(selector);
    const parsed = parseTheme(readFileSync(join(builtinDir, `${id}.json`), "utf8"));
    assert.equal(parsed.error, undefined);
    assert.equal(parsed.base, id);
    const mismatches: string[] = [];
    for (const key of [...COLOR_KEYS, ...SHADOW_KEYS]) {
      const want = flat(css, CSS_PROPERTY[key]!);
      if (parsed.tokens[key] !== want) mismatches.push(`${key}: ${parsed.tokens[key]} !== ${want}`);
    }
    assert.deepEqual(mismatches, [], `${id}.json drifted from tokens.css`);
  });
}

/* --- (d) $name resolution ------------------------------------------------ */

test("(d) $name resolves, and only to a var defined above it", () => {
  const ok = theme({
    name: "Refs",
    extends: "dark",
    vars: { base: "#101014", alias: "$base" },
    colors: { bg: "$base", surface: "$alias", ink: "#fff" },
  });
  assert.equal(ok.error, undefined);
  assert.deepEqual(ok.warnings, []);
  assert.equal(ok.tokens.bg, "#101014");
  assert.equal(ok.tokens.surface, "#101014");

  const forward = theme({ name: "Fwd", vars: { early: "$late", late: "#fff" }, colors: { bg: "$early" } });
  assert.ok(forward.error, "a forward reference is an error");
  assert.ok(forward.warnings.some((w) => w.includes("defined below it")));
  assert.equal(forward.tokens.bg, undefined);

  const self = theme({ name: "Cycle", vars: { a: "$a" }, colors: { bg: "$a" } });
  assert.ok(self.error, "a self reference — the shortest cycle — is an error");
  assert.equal(self.tokens.bg, undefined);

  const unknown = theme({ name: "Unknown", vars: { a: "#fff" }, colors: { bg: "$nope" } });
  assert.ok(unknown.error);
  assert.ok(unknown.warnings.some((w) => w.includes("$nope")));
  assert.equal(unknown.tokens.bg, undefined);
});

test("(d) validation runs after resolution, never before", () => {
  // Backwards, "$base" is checked as a color and every theme using vars dies at once with a
  // message naming the color grammar (§0). The reason below must name the var, not the grammar.
  const t = theme({ name: "Order", vars: { base: "not-a-color" }, colors: { bg: "$base" } });
  assert.ok(t.error);
  assert.ok(t.error!.includes("bg is not-a-color"), `the reason quotes the resolved value: ${t.error}`);
  assert.ok(!t.error!.includes("$base"));
});

/* --- (e) a user file over a built-in ------------------------------------- */

test("(e) a user file taking a built-in id replaces it, in place, and says so", () => {
  clearUserThemes();
  dropUserTheme("dracula", { $schema: "pi-web-theme/v1", name: "Dracula (mine)", extends: "light", colors: { accent: "#ff0000" } });
  dropUserTheme("sunset", { $schema: "pi-web-theme/v1", name: "Sunset", extends: "dark", colors: { bg: "#2b1a12" } });
  const { themes, dir } = listThemes();
  assert.equal(dir, userDir);
  assert.equal(themes.length, 19, "18 built-ins, one replaced, plus one new");

  const dracula = themes.find((t) => t.id === "dracula")!;
  assert.equal(dracula.source, "user");
  assert.equal(dracula.replacesBuiltin, true);
  assert.equal(dracula.name, "Dracula (mine)");
  assert.equal(dracula.base, "light");
  assert.equal(dracula.path, join(userDir, "dracula.json"));
  assert.equal(dracula.tokens.accent, "#ff0000");
  assert.equal(dracula.tokens.bg, "#F2F2F7", "the rest comes from the light base it extends");

  const sunset = themes.find((t) => t.id === "sunset")!;
  assert.equal(sunset.source, "user");
  assert.equal(sunset.replacesBuiltin, undefined);
  assert.equal(themes.at(-1)!.id, "sunset", "a user theme that replaces nothing comes last");
  assert.ok(themes.findIndex((t) => t.id === "dracula") < themes.findIndex((t) => t.id === "sunset"));
  clearUserThemes();
});

test("(e) the user folder is rescanned per request, and a missing one is not an error", () => {
  clearUserThemes();
  assert.equal(listThemes().themes.length, 18);
  dropUserTheme("later", { name: "Later", extends: "dark", colors: { bg: "#000" } });
  assert.equal(listThemes().themes.length, 19, "no watch, no cache: the next request sees it");
  rmSync(userDir, { recursive: true, force: true });
  const gone = listThemes();
  assert.equal(gone.error, undefined, "a folder nobody made is not a failure");
  assert.equal(gone.themes.length, 18);
  mkdirSync(userDir, { recursive: true });
});

/* --- (f) the two ways a file goes wrong ---------------------------------- */

test("(f) a file that isn't JSON becomes a row carrying the parser's own message", () => {
  clearUserThemes();
  dropUserTheme("broken", '{\n  "name": "Broken",\n');
  const t = listThemes().themes.find((x) => x.id === "broken")!;
  assert.equal(t.name, "", "§12 shows the filename where the name would be");
  assert.ok(t.error, "a broken file is listed, never silently dropped");
  assert.ok(/JSON/i.test(t.error!), `the parser's own words: ${t.error}`);
  assert.deepEqual(t.tokens, {});
  assert.equal(t.path, join(userDir, "broken.json"));
  clearUserThemes();
});

test("(f) a file with no name is a broken row too", () => {
  const t = theme({ extends: "dark", colors: { bg: "#000" } });
  assert.ok(t.error);
  assert.match(t.error!, /name/);
});

test("(f) a value we won't emit drops its key and names the key, the value and the shapes", () => {
  clearUserThemes();
  dropUserTheme("bad-value", {
    $schema: "pi-web-theme/v1",
    name: "Bad Value",
    extends: "dark",
    colors: { bg: "#101014", accent: "image-set(//a/x.png 1x)" },
  });
  const t = listThemes().themes.find((x) => x.id === "bad-value")!;
  assert.equal(t.warnings.length, 1);
  assert.match(t.warnings[0]!, /^accent is image-set\(\/\/a\/x\.png 1x\)\. A color is a hex value, or one call to rgb, rgba, hsl, hsla, oklch, oklab, lab, lch, color-mix, or color\.$/);
  assert.equal(t.error, t.warnings[0], "§0: the theme it came from is not applied");
  assert.notEqual(t.tokens.accent, "image-set(//a/x.png 1x)", "the value never reaches a DOM node");
  assert.equal(t.tokens.bg, "#101014", "the keys that were fine are still there");
  clearUserThemes();
});

test("(f) an unknown key is inert, not fatal", () => {
  const t = theme({ name: "Extra", extends: "dark", colors: { bg: "#000", "not-a-token": "#fff" } });
  assert.equal(t.error, undefined);
  assert.equal(t.warnings.length, 1);
  assert.match(t.warnings[0]!, /not-a-token/);
  assert.equal(t.tokens["not-a-token"], undefined);
  assert.equal(t.tokens.bg, "#000");
});

test("(f) an unreadable user folder keeps the built-ins listed and reports why", () => {
  clearUserThemes();
  writeFileSync(join(agentDir, "pi-web", "themes-file"), "not a folder");
  const prev = process.env.PI_CODING_AGENT_DIR;
  try {
    // A path whose "themes" is a file, not a directory: readdir fails with something other than
    // ENOENT, which is the case §12's banner exists for.
    const scratch = mkdtempSync(join(tmpdir(), "pi-web-themes-file-"));
    mkdirSync(join(scratch, "pi-web"), { recursive: true });
    writeFileSync(join(scratch, "pi-web", "themes"), "not a folder");
    process.env.PI_CODING_AGENT_DIR = scratch;
    const r = listThemes();
    assert.ok(r.error, "the folder's failure is reported");
    assert.equal(r.themes.length, 18, "the app's own themes don't depend on it");
    rmSync(scratch, { recursive: true, force: true });
  } finally {
    process.env.PI_CODING_AGENT_DIR = prev;
  }
});

/* --- (g) the merge over both bases --------------------------------------- */

test("(g) a three-key theme is a whole theme over either base", () => {
  const darkBase = parseTheme(readFileSync(join(builtinDir, "dark.json"), "utf8")).tokens;
  const lightBase = parseTheme(readFileSync(join(builtinDir, "light.json"), "utf8")).tokens;
  clearUserThemes();
  dropUserTheme("tiny-dark", { name: "Tiny Dark", extends: "dark", colors: { accent: "#00ff00" } });
  dropUserTheme("tiny-light", { name: "Tiny Light", extends: "light", colors: { accent: "#00ff00" } });
  dropUserTheme("typed", {
    name: "Typed",
    extends: "light",
    vars: { face: '"Iosevka", ui-monospace, monospace' },
    typography: { "font-mono": "$face", "fs-body": "15px", "fw-medium": "500", "ls-body": "0", "lh-body": "1.6" },
  });
  const themes = listThemes().themes;

  for (const [id, base] of [["tiny-dark", darkBase], ["tiny-light", lightBase]] as const) {
    const t = themes.find((x) => x.id === id)!;
    assert.equal(t.error, undefined);
    assert.equal(Object.keys(t.tokens).length, 30, "the base fills everything it omitted");
    assert.equal(t.tokens.accent, "#00ff00");
    assert.deepEqual({ ...t.tokens, accent: base.accent }, base, "nothing but accent moved");
  }

  const typed = themes.find((x) => x.id === "typed")!;
  assert.equal(typed.error, undefined);
  assert.equal(typed.tokens["font-mono"], '"Iosevka", ui-monospace, monospace', "a $name in typography too");
  assert.equal(typed.tokens["fs-body"], "15px");
  assert.equal(typed.tokens.bg, lightBase.bg, "colors still come from the base");
  assert.equal(typed.tokens["font-body"], undefined, "typography it didn't set stays with tokens.css");
  clearUserThemes();
});
