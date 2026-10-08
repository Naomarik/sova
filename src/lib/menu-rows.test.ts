// Run: pnpm test -- src/lib/menu-rows.test.ts
//
// Every menu row is the one popover row (§design/menu-rows), and only that row sets its own
// alignment. Two static checks over src/:
//
// (a) Every JSX element with role=menuitem|menuitemradio|menuitemcheckbox carries the class
//     `popover-item` — read from its `class` attribute, or from the object literal it spreads
//     (ActionMenu's `shared`). An element whose role the scan cannot read (`role={p.r.role}`)
//     counts as a menu row. A `<button class="button …">` with a menuitem role is a side action
//     beside a row (Configure Delegate's gear, a host's Resync), not a row.
// (b) No stylesheet sets align-items, vertical padding or a min height on a rule whose selector
//     names `.popover-item` or `.popover-item-detail`, outside the primitive's own block in
//     base.css (from its `---- POPOVER (menu)` banner to the next `/* ----` banner).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SRC = fileURLToPath(new URL("../", import.meta.url));
const BASE_CSS = join(SRC, "design/base.css");
const PRIMITIVE_BANNER = "---- POPOVER (menu)";

function walk(dir: string, ext: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, ext));
    else if (e.name.endsWith(ext)) out.push(p);
  }
  return out.sort();
}

// ---- (a) menu rows in TSX ------------------------------------------------------------

type Row = { file: string; line: number; tag: string; role: string; classText: string | null; sideAction: boolean };

const MENU_ROLE = /\bmenuitem(radio|checkbox)?\b/;
const hasClass = (text: string, name: string) => new RegExp(`(^|[\\s"'\`])${name}(?=$|[\\s"'\`])`).test(text);

/** A role the scan can read is a string somewhere in the attribute; one with no string at all is unknown. */
function roleIsMenu(roleText: string): boolean {
  if (MENU_ROLE.test(roleText)) return true;
  return !/["'`]/.test(roleText);
}

function menuRows(file: string, source: string): Row[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const objects = new Map<string, ts.ObjectLiteralExpression>();
  const visitDecl = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      let init: ts.Expression = n.initializer;
      while (ts.isAsExpression(init) || ts.isSatisfiesExpression(init) || ts.isParenthesizedExpression(init)) init = init.expression;
      if (ts.isObjectLiteralExpression(init)) objects.set(n.name.text, init);
    }
    ts.forEachChild(n, visitDecl);
  };
  visitDecl(sf);
  const propText = (obj: ts.ObjectLiteralExpression, name: string): string | null => {
    for (const p of obj.properties) {
      const key = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null;
      if (key === name && (ts.isPropertyAssignment(p) || ts.isGetAccessorDeclaration(p))) return p.getText(sf);
    }
    return null;
  };

  const rows: Row[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      let role: string | null = null;
      let classText: string | null = null;
      for (const a of n.attributes.properties) {
        if (ts.isJsxAttribute(a)) {
          const name = a.name.getText(sf);
          const text = a.initializer ? a.initializer.getText(sf) : "";
          if (name === "role") role = text;
          if (name === "class" || name === "className") classText = text;
        } else if (ts.isJsxSpreadAttribute(a) && ts.isIdentifier(a.expression)) {
          const obj = objects.get(a.expression.text);
          if (obj) {
            role = propText(obj, "role") ?? role;
            classText = propText(obj, "class") ?? classText;
          }
        }
      }
      if (role !== null && roleIsMenu(role)) {
        const tag = n.tagName.getText(sf);
        rows.push({
          file: relative(SRC, file),
          line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
          tag,
          role,
          classText,
          sideAction: tag === "button" && classText !== null && hasClass(classText, "button"),
        });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return rows;
}

const ROWS = walk(SRC, ".tsx").flatMap((f) => menuRows(f, readFileSync(f, "utf8")));

test("the TSX scan finds rows it should and misses none it shouldn't", () => {
  const fixture = [
    `const shared = { class: "popover-item", role: "menuitem" } as const;`,
    `const bad = { get class() { return "mode-option"; }, role: "menuitem" };`,
    `export const A = () => <div {...shared} />;`,
    `export const B = () => <div {...bad} />;`,
    `export const C = (p: any) => <div class="other" role={p.r.role} />;`,
    `export const D = () => <div class="popover-item popover-item-detail" role="menuitemradio" />;`,
    `export const E = () => <div class="popover-itemish" role="menuitemcheckbox" />;`,
    `export const F = () => <button class="button button-icon" role="menuitem" />;`,
    `export const G = (t: boolean) => <span role={t ? "img" : undefined} />;`,
    `export const H = () => <div role="menu" />;`,
  ].join("\n");
  const rows = menuRows("fixture.tsx", fixture);
  const bad = rows.filter((r) => !r.sideAction && !(r.classText && hasClass(r.classText, "popover-item")));
  assert.deepEqual(rows.map((r) => r.line), [3, 4, 5, 6, 7, 8]);
  assert.deepEqual(bad.map((r) => r.line), [4, 5, 7]);
  assert.deepEqual(rows.filter((r) => r.sideAction).map((r) => r.line), [8]);
});

test("every menu row in src/ is a .popover-item", () => {
  // The menus this primitive was built for: a scan that stops finding them has gone blind.
  const files = new Set(ROWS.map((r) => r.file));
  for (const f of [
    "components/ActionMenu.tsx",
    "components/Groups.tsx",
    "components/GroupView.tsx",
    "components/ComposerMenu.tsx",
    "components/ModeMenu.tsx",
    "components/MeshHostMenu.tsx",
    "components/AlignChip.tsx",
    "components/OverseerCardChip.tsx",
    "components/CostsTab.tsx",
  ]) {
    assert.ok(files.has(f), `no menu row found in ${f}`);
  }
  const missing = ROWS.filter((r) => !r.sideAction && !(r.classText !== null && hasClass(r.classText, "popover-item")));
  assert.deepEqual(
    missing.map((r) => `${r.file}:${r.line} <${r.tag} role=${r.role}> class=${r.classText ?? "(none)"}`),
    [],
    "menu rows without .popover-item",
  );
});

// ---- (b) nothing else sets a row's alignment ------------------------------------------

type Rule = { selector: string; decls: string[]; line: number; offset: number };

/** Blank comments to spaces, keeping newlines, so offsets still give line numbers. */
const blankComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));

function styleRules(css: string): Rule[] {
  const src = blankComments(css);
  const lineAt = (i: number) => src.slice(0, i).split("\n").length;
  const out: Rule[] = [];
  const matchBrace = (open: number) => {
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) return i;
    }
    throw new Error(`unbalanced "{" at line ${lineAt(open)}`);
  };
  const walkRange = (from: number, to: number) => {
    let start = from;
    for (let i = from; i < to; i++) {
      const ch = src[i];
      if (ch === ";") start = i + 1;
      else if (ch === "{") {
        const prelude = src.slice(start, i).trim();
        const end = matchBrace(i);
        if (prelude.startsWith("@")) {
          if (/^@(media|supports|container|layer|scope)\b/.test(prelude)) walkRange(i + 1, end);
        } else {
          const body = src.slice(i + 1, end);
          if (body.includes("{")) throw new Error(`nested CSS in "${prelude}" (line ${lineAt(i)}) is not parsed by this test`);
          const at = start + src.slice(start, i).search(/\S/);
          out.push({ selector: prelude, decls: body.split(";").map((d) => d.trim()).filter(Boolean), line: lineAt(at), offset: at });
        }
        i = end;
        start = end + 1;
      }
    }
  };
  walkRange(0, src.length);
  return out;
}

/** The selector list with `:not(…)` and `:has(…)` dropped: they name what is excluded or inside, not what is styled. */
function styledPart(selector: string): string {
  let out = selector.replace(/\[[^\]]*\]/g, "");
  for (const name of [":not(", ":has("]) {
    for (let at = out.indexOf(name); at >= 0; at = out.indexOf(name)) {
      let depth = 0;
      let j = at + name.length - 1;
      for (; j < out.length; j++) {
        if (out[j] === "(") depth++;
        else if (out[j] === ")" && --depth === 0) break;
      }
      out = out.slice(0, at) + out.slice(j + 1);
    }
  }
  return out;
}

const ROW_CLASS = /\.popover-item(-detail)?(?![\w-])/;
const ALIGNMENT = /^(align-items|min-height|padding|padding-top|padding-bottom|padding-block|padding-block-start|padding-block-end)\s*:/i;

function overrides(file: string, css: string, primitive: [number, number] | null): string[] {
  return styleRules(css)
    .filter((r) => !(primitive && r.offset >= primitive[0] && r.offset < primitive[1]))
    .filter((r) => ROW_CLASS.test(styledPart(r.selector)))
    .flatMap((r) => r.decls.filter((d) => ALIGNMENT.test(d)).map((d) => `${file}:${r.line} ${r.selector.replace(/\s+/g, " ")} { ${d} }`));
}

/** base.css's primitive block: from its banner to the next section banner. */
function primitiveBlock(css: string): [number, number] {
  const start = css.indexOf(PRIMITIVE_BANNER);
  assert.ok(start >= 0, `base.css has no "${PRIMITIVE_BANNER}" banner`);
  const next = css.indexOf("/* ----", start + PRIMITIVE_BANNER.length);
  assert.ok(next > start, "the popover block has no section after it");
  return [start, next];
}

test("the CSS scan flags an override and leaves the primitive and its slots alone", () => {
  const css = [
    "/* ---- POPOVER (menu). */",
    ".popover-item { display: flex; align-items: center; padding: var(--space-1) var(--space-3); }",
    ".popover-item-detail { align-items: flex-start; padding-block: var(--space-2); }",
    "/* ---- NEXT. */",
    ".group-menu .popover-item { align-items: center; }",
    "@media (min-width: 768px) { .x > .popover-item-detail { padding: 0 var(--space-3); } }",
    ".popover-item-icon { align-items: center; }",
    ".row:has(> .popover-item) { align-items: stretch; }",
    ".popover-item[aria-disabled=\"true\"] { cursor: progress; }",
    ".popover-item { padding-inline: 0; }",
    ".y .popover-item { min-height: 0; }",
  ].join("\n");
  const found = overrides("f.css", css, primitiveBlock(css));
  assert.deepEqual(found, [
    "f.css:5 .group-menu .popover-item { align-items: center }",
    "f.css:6 .x > .popover-item-detail { padding: 0 var(--space-3) }",
    "f.css:11 .y .popover-item { min-height: 0 }",
  ]);
});

test("no stylesheet in src/ sets a menu row's alignment outside the primitive", () => {
  const files = walk(SRC, ".css");
  assert.ok(files.includes(BASE_CSS), "base.css not found");
  const found = files.flatMap((f) => {
    const css = readFileSync(f, "utf8");
    return overrides(relative(SRC, f), css, f === BASE_CSS ? primitiveBlock(css) : null);
  });
  assert.deepEqual(found, [], "align-items / vertical padding / min-height set on a menu row outside base.css's popover block");
});
