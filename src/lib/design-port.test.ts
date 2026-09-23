// Run: npx tsx --test src/lib/design-port.test.ts (or npm test)
//
// Falsifies the design skill's `Ported` column against the CSS the app actually loads.
// The skill documents 25 components; Sova imports only src/design/tokens.css + base.css,
// and base.css is a hand-ported subset. SKILL.md's `## Components` table says, per
// component, whether that subset has it (yes / no / partial — <what is missing>). This
// test reads the `## Class index` table for each component's selectors and checks each
// claim against the rules base.css really has, in both directions. (It lives here, not
// in the skill's .build/audit.mjs, because the skill must stay self-contained when
// copied to another repo.)
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SKILL_MD = fileURLToPath(new URL("../../.claude/skills/fold-ai-dev-design/SKILL.md", import.meta.url));
const BASE_CSS = fileURLToPath(new URL("../design/base.css", import.meta.url));
const SKILL_CSS = fileURLToPath(new URL("../../.claude/skills/fold-ai-dev-design/fold-ai-dev.css", import.meta.url));
const COMPONENTS_DIR = fileURLToPath(new URL("../../.claude/skills/fold-ai-dev-design/reference/components/", import.meta.url));
// 25 components (one reference file and one class-index row each) in 27 table rows:
// the Components table splits Overlay into Modal, Sheet and Popover.
const EXPECTED_COMPONENTS = 25;
const EXPECTED_ROWS = 27;

// ---- Markdown tables ----------------------------------------------------------

/** Split a table row on `|`, except inside backticks (the class index writes `.banner-success|warn`). */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let inCode = false;
  for (const ch of line.trim().replace(/^\|/, "").replace(/\|$/, "")) {
    if (ch === "`") inCode = !inCode;
    if (ch === "|" && !inCode) {
      cells.push(cell.trim());
      cell = "";
    } else cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}

/** The first table under `## <heading>`, as rows keyed by header. Throws if absent or malformed. */
function parseTable<C extends string>(md: string, heading: string, columns: readonly C[]): Record<C, string>[] {
  const lines = md.split("\n");
  const at = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (at < 0) throw new Error(`SKILL.md has no "## ${heading}" section`);
  const end = lines.findIndex((l, i) => i > at && /^## /.test(l));
  const section = lines.slice(at + 1, end < 0 ? undefined : end);
  const first = section.findIndex((l) => l.trim().startsWith("|"));
  if (first < 0) throw new Error(`"## ${heading}" has no table`);
  const tableLines: string[] = [];
  for (const l of section.slice(first)) {
    if (!l.trim().startsWith("|")) break;
    tableLines.push(l);
  }
  const [head = "", sep, ...body] = tableLines;
  const header = splitRow(head);
  if (JSON.stringify(header) !== JSON.stringify(columns)) {
    throw new Error(`"## ${heading}" table header is ${JSON.stringify(header)}, expected ${JSON.stringify(columns)}`);
  }
  if (!sep || !splitRow(sep).every((c) => /^:?-{3,}:?$/.test(c))) {
    throw new Error(`"## ${heading}" table has no separator row under its header`);
  }
  if (body.length === 0) throw new Error(`"## ${heading}" table has no rows`);
  return body.map((line, i) => {
    const cells = splitRow(line);
    if (cells.length !== columns.length) {
      throw new Error(`"## ${heading}" row ${i + 1} has ${cells.length} cells, expected ${columns.length}: ${line}`);
    }
    return Object.fromEntries(columns.map((c, j) => [c, cells[j] ?? ""])) as Record<C, string>;
  });
}

/**
 * Documented selectors from a class-index cell, one entry per requirement.
 * `.banner-success|warn|error|info` is ONE entry of alternatives (swap the last hyphen
 * segment), satisfied by any of them; everything after "demo only:" is a demo state
 * (`.is-hover`…), not the component's own class.
 */
function classesOf(cell: string): string[][] {
  const own = cell.split(/demo only:/)[0] ?? "";
  const out: string[][] = [];
  for (const [, code = ""] of own.matchAll(/`([^`]+)`/g)) {
    const [firstPart = "", ...alts] = code.split("|");
    const first = firstPart.replace(/^\./, "");
    if (!/^[a-z][\w-]*$/.test(first)) throw new Error(`class index entry "${code}" is not a class`);
    const stem = first.slice(0, first.lastIndexOf("-"));
    out.push([first, ...alts.map((alt) => `${stem}-${alt}`)]);
  }
  return out;
}

// ---- CSS rules --------------------------------------------------------------------

type Rule = { selector: string; decls: string[]; line: number };

/** Blank comments to spaces, keeping newlines, so offsets still give line numbers. */
function blankComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
}

function skipString(src: string, i: number): number {
  const q = src[i];
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === "\\") j++;
    else if (src[j] === q) return j;
  }
  throw new Error(`unterminated string at offset ${i}`);
}

function matchBrace(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'") i = skipString(src, i);
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i;
  }
  throw new Error(`unbalanced "{" at offset ${open}`);
}

/**
 * Every style rule, descending into conditional group rules (@media, @container, …) and
 * skipping @keyframes / @font-face, whose preludes are not selectors. CSS nesting is
 * refused rather than guessed at: a mis-parsed nested rule would be a silent miss.
 */
function styleRules(css: string): Rule[] {
  const src = blankComments(css);
  const lineAt = (i: number) => src.slice(0, i).split("\n").length;
  const out: Rule[] = [];
  const walk = (from: number, to: number) => {
    let start = from;
    for (let i = from; i < to; i++) {
      const ch = src[i];
      if (ch === '"' || ch === "'") i = skipString(src, i);
      else if (ch === ";") start = i + 1;
      else if (ch === "}") throw new Error(`stray "}" at line ${lineAt(i)}`);
      else if (ch === "{") {
        const prelude = src.slice(start, i).trim();
        const end = matchBrace(src, i);
        if (prelude.startsWith("@")) {
          if (/^@(media|supports|container|layer|scope|document)\b/.test(prelude)) walk(i + 1, end);
        } else {
          const body = src.slice(i + 1, end);
          if (body.includes("{")) throw new Error(`nested CSS in "${prelude}" (line ${lineAt(i)}) is not parsed by this test`);
          const decls = body.split(";").map((d) => d.trim()).filter(Boolean);
          out.push({ selector: prelude, decls, line: lineAt(start + src.slice(start, i).search(/\S/)) });
        }
        i = end;
        start = end + 1;
      }
    }
  };
  walk(0, src.length);
  return out;
}

/** Drop `name(...)` groups with balanced parens. */
function dropFunctional(sel: string, name: string): string {
  let out = sel;
  for (let at = out.indexOf(name); at >= 0; at = out.indexOf(name)) {
    let depth = 0;
    let j = at + name.length - 1;
    for (; j < out.length; j++) {
      if (out[j] === "(") depth++;
      else if (out[j] === ")" && --depth === 0) break;
    }
    out = out.slice(0, at) + out.slice(j + 1);
  }
  return out;
}

/**
 * The classes a selector list styles. Attribute values and strings go first (a `.` in
 * `[href$=".md"]` is not a class); `:not()` names what is excluded and `:has()` what is
 * inside — neither is styled by the rule. A complex selector scoped under `.md` styles
 * the app's rendered markdown, not a skill component, so it owns nothing here.
 */
function classesStyled(selectorList: string): Set<string> {
  const out = new Set<string>();
  const clean = selectorList.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, "").replace(/\[[^\]]*\]/g, "");
  let depth = 0;
  let part = "";
  const parts: string[] = [];
  for (const ch of clean) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(part);
      part = "";
    } else part += ch;
  }
  parts.push(part);
  for (const p of parts) {
    const styled = dropFunctional(dropFunctional(p, ":not("), ":has(");
    const classes = [...styled.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1] ?? "");
    if (classes.includes("md")) continue;
    for (const c of classes) out.add(c);
  }
  return out;
}

/**
 * A rule that only hides its element is a stub, not a port: base.css's top-level
 * `.sheet-grip { display: none; }` (it is drawn only inside the folded @media).
 */
const isStub = (r: Rule) => r.decls.length === 0 || r.decls.every((d) => /^display\s*:\s*none$/i.test(d));

// ---- Component → selectors --------------------------------------------------------

/** Components-table names the class index files under another row. */
const INDEX_ROW: Record<string, string> = { "List & row": "List", Modal: "Overlay", Sheet: "Overlay", Popover: "Overlay" };
/** The Overlay row covers three components; each takes its own classes by prefix. */
const OVERLAY_PREFIXES: Record<string, string[]> = { Modal: ["scrim", "modal"], Sheet: ["sheet"], Popover: ["popover"] };
/**
 * Classes the skill names for a component that base.css uses for a different Sova
 * component. Sova's session axis (`.timeline`, ~line 4188) also owns `.timeline-title`,
 * `.timeline-meta` and `.timeline-body`; only the skill's step/marker/state classes can
 * say whether Run timeline was ported.
 */
const SHARED_WITH_SOVA: Record<string, string[]> = {
  "Run timeline": ["timeline", "timeline-title", "timeline-meta", "timeline-body"],
};

/**
 * Demo helpers, measured from the skill's own CSS: a rule whose comment says
 * "Demo helper." styles a documentation page, not the component, so the app need not
 * ship it. Today that is `.button-row` (fold-ai-dev.css:106) and `.tip-static`
 * (fold-ai-dev.css:1200). The `.is-*` static states (fold-ai-dev.css:93 and :214,
 * "DEMO/DOCUMENTATION ONLY") never reach this list: the class index files them after
 * its own "· demo only:" marker, which classesOf() drops.
 */
function demoHelpers(): Map<string, number> {
  const css = readFileSync(SKILL_CSS, "utf8");
  const out = new Map<string, number>();
  for (const m of css.matchAll(/\/\*\s*Demo helper\.\s*\*\/\s*([^{]+)\{/g)) {
    const line = css.slice(0, m.index).split("\n").length;
    const first = /^\.(-?[_a-zA-Z][\w-]*)/.exec((m[1] ?? "").trim());
    if (!first?.[1]) throw new Error(`fold-ai-dev.css:${line}: "Demo helper." comment is not followed by a class rule`);
    out.set(first[1], line);
  }
  return out;
}
const DEMO = demoHelpers();

type Claim = {
  component: string;
  indexName: string;
  status: "yes" | "no" | "partial";
  note: string;
  /** Each entry is one documented selector; `|` alternatives share an entry. */
  classes: string[][];
  /** Documented selectors excluded from the `yes` requirement as demo helpers. */
  demo: string[];
};

const SKILL = readFileSync(SKILL_MD, "utf8");
/** Class-index rows that are components (not the Utilities row). */
const INDEX_COMPONENTS = parseTable(SKILL, "Class index", ["Component", "Selectors"])
  .map((r) => r.Component)
  .filter((c) => c !== "Utilities");

function claims(): Claim[] {
  const md = SKILL;
  const components = parseTable(md, "Components", ["Component", "Variants", "Sizes", "Key rule", "Ported"]);
  const index = new Map(parseTable(md, "Class index", ["Component", "Selectors"]).map((r) => [r.Component, classesOf(r.Selectors)]));
  return components.map((row) => {
    const component = row.Component;
    const m = /^(yes|no|partial)(?:\s+—\s+(.+))?$/.exec(row.Ported);
    if (!m) throw new Error(`${component}: Ported cell "${row.Ported}" is not yes / no / partial — <note>`);
    const status = m[1] as Claim["status"];
    if (status === "partial" && !m[2]) throw new Error(`${component}: "partial" must say what is missing after an em dash`);
    if (status !== "partial" && m[2]) throw new Error(`${component}: only "partial" carries a note, got "${row.Ported}"`);
    const indexName = INDEX_ROW[component] ?? component;
    let classes = index.get(indexName);
    if (!classes) throw new Error(`${component}: no "${indexName}" row in the class index`);
    const prefixes = OVERLAY_PREFIXES[component];
    if (prefixes) classes = classes.filter(([c = ""]) => prefixes.some((p) => c === p || c.startsWith(`${p}-`)));
    const shared = SHARED_WITH_SOVA[component] ?? [];
    for (const s of shared) {
      if (!classes.some((g) => g.includes(s))) throw new Error(`${component}: shared-class exclusion ".${s}" is not in its class index row — stale exclusion`);
    }
    classes = classes.filter((g) => !g.some((c) => shared.includes(c)));
    const demo = classes.filter((g) => g.every((c) => DEMO.has(c))).flat();
    classes = classes.filter((g) => !g.every((c) => DEMO.has(c)));
    if (classes.length === 0) throw new Error(`${component}: no selectors left to measure`);
    return { component, indexName, status, note: m[2] ?? "", classes, demo };
  });
}

/** class → first line of a non-stub rule in base.css that styles it. */
function ported(): Map<string, number> {
  const owned = new Map<string, number>();
  for (const rule of styleRules(readFileSync(BASE_CSS, "utf8"))) {
    if (isStub(rule)) continue;
    for (const c of classesStyled(rule.selector)) if (!owned.has(c)) owned.set(c, rule.line);
  }
  return owned;
}

// ---- Tests --------------------------------------------------------------------------

const CLAIMS = claims();
const OWNED = ported();
const name = (g: string[]) => g.map((c) => `.${c}`).join("|");
const list = (gs: string[][]) => gs.map(name).join(" ");
const withLines = (gs: string[][]) =>
  gs.map((g) => `${name(g)} (base.css:${OWNED.get(g.find((c) => OWNED.has(c)) ?? "")})`).join(", ");

test(`SKILL.md's Components table covers all ${EXPECTED_COMPONENTS} components in ${EXPECTED_ROWS} rows`, () => {
  assert.equal(CLAIMS.length, EXPECTED_ROWS, `Components table has ${CLAIMS.length} rows: ${CLAIMS.map((c) => c.component).join(", ")}`);
  assert.equal(new Set(CLAIMS.map((c) => c.component)).size, CLAIMS.length, "a component is listed twice");
  const covered = new Set(CLAIMS.map((c) => c.indexName));
  const uncovered = INDEX_COMPONENTS.filter((c) => !covered.has(c));
  assert.deepEqual(uncovered, [], `class-index components with no Ported claim: ${uncovered.join(", ")}`);
  assert.equal(covered.size, EXPECTED_COMPONENTS, `Components table covers ${covered.size} class-index components: ${[...covered].join(", ")}`);
  const files = readdirSync(COMPONENTS_DIR).filter((f) => f.endsWith(".md"));
  assert.equal(files.length, EXPECTED_COMPONENTS, `reference/components/ has ${files.length} files`);
  const said = /^(\d+) components\./m.exec(SKILL)?.[1];
  assert.equal(Number(said), EXPECTED_COMPONENTS, `SKILL.md says "${said} components."`);
});

test("the CSS reader is not fooled by comments, markdown, :not() or stubs", () => {
  const css = [
    "/* .tree .popover { color: red } */",
    ".md table, .md .table-wrap { color: red; }",
    ".md-table-wrap { overflow: auto; }",
    ".row:not(.tip) { color: red; }",
    ".row:has(.diff) { color: red; }",
    '.row[data-x=".rail"] { color: red; }',
    ".sheet-grip { display: none; }",
    "@keyframes spin { from { opacity: 0; } to { opacity: 1; } }",
    "@media (max-width: 767px) { .sheet-grip { display: block; } }",
  ].join("\n");
  const owned = new Set<string>();
  for (const r of styleRules(css)) if (!isStub(r)) for (const c of classesStyled(r.selector)) owned.add(c);
  assert.deepEqual([...owned].sort(), ["md-table-wrap", "row", "sheet-grip"]);
  assert.throws(() => styleRules(".a { .b { color: red; } }"), /nested CSS/);
});

test("demo helpers are measured, not assumed", () => {
  // If the skill drops or adds a "Demo helper." rule, this list and the comment on
  // demoHelpers() must change with it.
  assert.deepEqual([...DEMO.keys()].sort(), ["button-row", "tip-static"]);
});

/**
 * yes: every documented selector (demo helpers aside) has a rule in base.css.
 * partial: some have one and some do not, and the note names every missing selector.
 * no: none has one.
 */
for (const { component, status, note, classes } of CLAIMS) {
  test(`Ported: ${component} is "${status}"`, () => {
    const have = classes.filter((g) => g.some((c) => OWNED.has(c)));
    const missing = classes.filter((g) => !g.some((c) => OWNED.has(c)));
    if (status === "yes") {
      assert.deepEqual(missing, [], `${component}: Ported says "yes" but base.css has no rule for ${list(missing)}`);
    } else if (status === "no") {
      assert.equal(have.length, 0, `${component}: Ported says "no" but base.css has rules for ${withLines(have)} (looked for ${list(classes)})`);
    } else {
      assert.ok(have.length > 0, `${component}: Ported says "partial — ${note}" but base.css has no rule for any of ${list(classes)}`);
      assert.ok(missing.length > 0, `${component}: Ported says "partial — ${note}" but base.css has rules for every one of ${withLines(have)}`);
      const unnamed = missing.filter((g) => !g.some((c) => new RegExp(`\\.${c}(?![\\w-])`).test(note)));
      assert.deepEqual(unnamed, [], `${component}: Ported says "partial — ${note}" but the note does not name missing ${list(unnamed)}`);
    }
  });
}
