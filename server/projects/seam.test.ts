// Run: pnpm exec tsx --test server/projects/seam.test.ts. The project/org seam in TypeScript (design §3, "TS
// modules"): no project-layer module reaches an org-layer module through its runtime imports, transitively. The org
// layer adds its part through server/projects/contributions.ts (registered when an org engine opens); the project
// layer never imports it. Type-only imports erase at compile time and are not edges. Reads the source only.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, test } from "node:test";
import ts from "typescript";

const REPO = resolve(import.meta.dirname, "..", "..");

/** Every .ts file under `dir` (relative to the repo), tests and test fixtures left out. */
function tsFiles(dir: string): string[] {
  const abs = join(REPO, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs).flatMap((name) => {
    const rel = `${dir}/${name}`;
    if (statSync(join(REPO, rel)).isDirectory()) return tsFiles(rel);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [rel] : [];
  });
}

const serverFiles = tsFiles("server").filter((f) => !f.startsWith("server/vendor/"));
const matching = (re: RegExp) => serverFiles.filter((f) => re.test(f));

/** The project layer (design §3, plus the modules the split moved out of the org layer's files). */
const PROJECT_LAYER = [
  ...matching(/^server\/projects\//),
  ...matching(/^server\/project-overseer[^/]*\.ts$/),
  ...matching(/^server\/project-services\//),
  ...matching(/^server\/org-host\//),
  ...matching(/^server\/project-costs[^/]*\.ts$/),
  ...[
    "server/project-root.ts",
    "server/build-loadout.ts",
    "server/project-previews.ts",
    "server/preview-links.ts",
    "server/project-worktrees.ts",
    "server/project-coding-mode.ts",
    "server/project-runtime.ts",
    "server/project-holds.ts",
    "server/project-sessions.ts",
    "server/session-prompt.ts",
    "server/user-turns.ts",
    "server/overseer-sender.ts",
    "server/org-engine.ts",
    "server/org-stamp.ts",
  ].filter((f) => serverFiles.includes(f)),
];

/** The org layer (design §3). */
const ORG_LAYER = new Set([
  ...[
    "server/orgs.ts",
    "server/org-routes.ts",
    "server/org-effects.ts",
    "server/org-sessions.ts",
    "server/reconcile.ts",
    "server/project-pipeline.ts",
    "server/project-updates.ts",
    "server/overseer-tools.ts",
  ].filter((f) => serverFiles.includes(f)),
  ...matching(/^server\/baton[^/]*\.ts$/),
  ...matching(/^server\/outreach\//),
  ...matching(/^server\/decisions[^/]*\.ts$/),
  ...matching(/^server\/owner[^/]*\.ts$/),
  ...matching(/^server\/overseer-org-[^/]*\.ts$/),
  "shared/orgs.ts",
]);

/** A specifier's file, or null: a package, or nothing on disk. */
function resolveSpec(from: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = join(dirname(from), spec);
  const stem = base.replace(/\.(ts|js|mjs)$/, "");
  for (const c of [base, `${stem}.ts`, `${stem}/index.ts`]) if (c.endsWith(".ts") && existsSync(join(REPO, c)) && statSync(join(REPO, c)).isFile()) return relative(REPO, join(REPO, c));
  return null;
}

/** A file's runtime imports: static imports and re-exports that are not type-only, and `import("…")`. */
function runtimeImports(file: string): string[] {
  const src = ts.createSourceFile(file, readFileSync(join(REPO, file), "utf8"), ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const c = node.importClause;
      const typeOnly = c && (c.isTypeOnly || (!c.name && c.namedBindings && ts.isNamedImports(c.namedBindings) && c.namedBindings.elements.length > 0 && c.namedBindings.elements.every((e) => e.isTypeOnly)));
      if (!typeOnly) out.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const typeOnly = node.isTypeOnly || (node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.every((e) => e.isTypeOnly));
      if (!typeOnly) out.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      out.push(node.arguments[0].text);
    } else if (ts.isImportTypeNode(node)) {
      return; // import("…").T is a type
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return out.map((s) => resolveSpec(file, s)).filter((f): f is string => f !== null);
}

const edges = new Map<string, string[]>();
const importsOf = (f: string): string[] => {
  let e = edges.get(f);
  if (!e) edges.set(f, (e = runtimeImports(f)));
  return e;
};

/** Each org-layer module `from` reaches, with the chain of imports that gets there. */
function reaches(from: string): string[][] {
  const seen = new Map<string, string[]>([[from, [from]]]);
  const queue = [from];
  const found: string[][] = [];
  while (queue.length) {
    const f = queue.shift()!;
    for (const g of importsOf(f)) {
      if (seen.has(g)) continue;
      const chain = [...seen.get(f)!, g];
      seen.set(g, chain);
      if (ORG_LAYER.has(g)) found.push(chain);
      else queue.push(g);
    }
  }
  return found;
}

describe("the TS seam: the project layer never reaches the org layer (design §3)", () => {
  test("both lists name real modules, and none is in both", () => {
    assert.ok(PROJECT_LAYER.length > 20, PROJECT_LAYER.join(", "));
    for (const f of ORG_LAYER) assert.ok(existsSync(join(REPO, f)), f);
    assert.deepEqual(PROJECT_LAYER.filter((f) => ORG_LAYER.has(f)), []);
  });

  test("the import reader sees runtime imports, re-exports and import(), never a type-only import", () => {
    const own = runtimeImports("server/projects/seam.test.ts");
    assert.ok(own.length === 0, "this file imports no repo module");
    assert.ok(importsOf("server/project-overseer.ts").includes("server/projects/spaces.ts"));
  });

  test("no project-layer module imports an org-layer module, directly or transitively", () => {
    const found = PROJECT_LAYER.flatMap(reaches).map((chain) => chain.join(" → "));
    assert.deepEqual([...new Set(found)], []);
  });
});
