// Run: pnpm test -- src/commands/palette-lazy.test.ts
// The palette and the shortcut sheet cost the page nothing until they're opened
// (§app.command-palette/opening): App reaches them only through `import()`, and no file the page
// loads at start imports their code statically, so the bundler keeps them in files of their own.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SRC = fileURLToPath(new URL("../", import.meta.url));

/** The palette's own files: they may import each other; nothing else may import them statically. */
const LAZY = ["components/CommandPalette", "components/ShortcutSheet", "commands/view", "lib/palette", "command-palette.css"];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

const stem = (file: string) => relative(SRC, file).replace(/\.(tsx?|css)$/, "").replace(/\\/g, "/");
const lazyStem = (spec: string, from: string): string | null => {
  if (!spec.startsWith(".")) return null;
  const s = stem(resolve(dirname(from), spec));
  return LAZY.find((l) => l.replace(/\.css$/, "") === s || l === `${s}.css` || l === s) ?? null;
};

/** Each file's static, value-carrying imports and its dynamic `import()`s. */
function importsOf(file: string): { static: string[]; dynamic: string[] } {
  const src = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out = { static: [] as string[], dynamic: [] as string[] };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && !node.importClause?.isTypeOnly) out.static.push(node.moduleSpecifier.text);
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && !node.isTypeOnly) out.static.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) out.dynamic.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(src);
  return out;
}

test("no file outside the palette's own imports its code statically", () => {
  const offenders: string[] = [];
  for (const file of walk(SRC)) {
    if (LAZY.includes(stem(file))) continue;
    for (const spec of importsOf(file).static) {
      const hit = lazyStem(spec, file);
      if (hit) offenders.push(`${stem(file)} imports ${hit}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("App opens both through import(), so each is a file the browser fetches on first use", () => {
  const dyn = importsOf(join(SRC, "App.tsx")).dynamic.map((s) => lazyStem(s, join(SRC, "App.tsx")));
  assert.ok(dyn.includes("components/CommandPalette"));
  assert.ok(dyn.includes("components/ShortcutSheet"));
});

test("the scan sees a static import when there is one", () => {
  // The check above is only evidence if it can fail: a static import in a stand-in file is found.
  const probe = ts.createSourceFile("x.tsx", 'import CommandPalette from "./components/CommandPalette";', ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const specs: string[] = [];
  probe.forEachChild((n) => ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && specs.push(n.moduleSpecifier.text));
  assert.equal(lazyStem(specs[0]!, join(SRC, "App.tsx")), "components/CommandPalette");
  assert.equal(lazyStem("../command-palette.css", join(SRC, "components/X.tsx")), "command-palette.css");
});
