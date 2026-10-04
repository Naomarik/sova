// The harness boundary scanner (§app.harness/boundary): a pure read of source text that finds where Sova
// code reaches pi outside server/harness/pi/. Imported only by server/harness-boundary.test.ts, which
// holds the ratchets against server/harness/boundary-baseline.json. TS AST only (as server/projects/
// seam.test.ts), so comments never count and every form of a reach is one rule.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import ts from "typescript";

/** A string that names a pi package (`+` catches `.pnpm/@earendil-works+pi-coding-agent@…` paths). */
export const PI = /@earendil-works[/+]/;

/** Paths the scan skips: the adapter, and the scanner's own files. Each must exist. */
export const EXCLUDED = ["server/harness/pi/", "server/harness-boundary.test.ts", "server/harness/boundary-scan.ts", "server/harness/fixtures/"];

/** Modules whose raw API is counted by import binding: the adapter's reader, and the transcript, which
    re-exports it until M2-Z. One raw module using or re-exporting another's raw API is the raw layer
    itself, not a reader: every file that imports either is counted. */
export const RAW_SOURCES = ["server/transcript.ts", "server/harness/pi/reader.ts"];
export const RAW_API = ["parseLines", "activeBranch", "readActiveBranch", "entryOf", "normalizeEntries", "normalizeEntry", "rawOf"];
/** Raw readers counted by property or identifier name, whatever the receiver. */
export const RAW_NAMES = ["getBranch", "getEntries", "getEntry", "rawBranch"];
/** pi's SessionEntry types plus the header (`session-manager.d.ts:128`). */
export const PI_TYPES = ["message", "custom", "custom_message", "model_change", "thinking_level_change", "usage", "compaction", "session_info", "label", "branch_summary", "context_edit", "session"];
/** pi's session and assistant-message event names, counted in src/ and shared/ (M3 shrinks them). */
export const PI_EVENTS = [
  "agent_start", "agent_end", "agent_settled", "turn_start", "turn_end", "message_start", "message_update", "message_end",
  "tool_execution_start", "tool_execution_update", "tool_execution_end", "queue_update", "compaction_start", "compaction_end",
  "auto_retry_start", "auto_retry_end", "entry_appended", "text_start", "text_delta", "text_end", "thinking_start",
  "thinking_delta", "thinking_end", "toolcall_start", "toolcall_delta", "toolcall_end",
];
/** The JSON spelling of a pi entry read off a raw line (the line prefilters). */
const JSON_SHAPE = new RegExp(`"type":"(?:${PI_TYPES.join("|")})"|"customType":"|"role":"`, "g");
/** Members only pi's SessionManager has (`session-manager.d.ts`), counted as reaches on any receiver. */
export const SM_MEMBERS = [
  "getLeafId", "getLeafEntry", "getSessionId", "getSessionFile", "getSessionName", "getSessionDir", "getCwd", "getHeader", "getLabel",
  "getChildren", "getTree", "buildSessionContext", "buildSessionProjection", "buildContextEntries", "appendMessage", "appendCompaction",
  "appendModelChange", "appendThinkingLevelChange", "appendSessionInfo", "appendLabelChange", "appendContextEdit", "branchWithSummary",
  "createBranchedSession", "resetLeaf", "isPersisted", "setSessionFile", "newSession", "usesDefaultSessionDir", "_persist",
];
/** Temporary bridges out of the adapter, counted as reaches by import binding. */
export const BRIDGES = ["liveRead", "stateOf"];
export const WRITERS = ["appendCustomEntry", "appendEntry", "appendSpecialEntry"];
/** The one file only the adapter may import (it reads pi worker transcripts). */
export const PI_ADAPTER_FILE = "pi-config/extensions/subagents/adapters/pi.ts";

const CODE = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/;
export const isTest = (path: string) => /\.test\.[cm]?[jt]sx?$/.test(path) || /(^|\/)tests\//.test(path);
export const isExcluded = (path: string) => EXCLUDED.some((e) => (e.endsWith("/") ? path.startsWith(e) : path === e));

export type ImportKind = "runtime" | "type";
export interface Hit { rule: string; line: number }
export interface Violation { code: "reexport" | "types-only"; line: number; message: string }

export interface FileScan {
  path: string;
  imports: ImportKind | null;
  importHits: Hit[];
  calls: Hit[];
  shapes: Hit[];
  reaches: Hit[];
  writers: Hit[];
  /** Functions that forward their own parameter as a written entry's type, by name. */
  wrappers: { name: string; line: number }[];
  violations: Violation[];
  /** Repo-relative files this one reaches by a runtime relative import (Zone B's edges). */
  edges: string[];
  /** Repo-relative files this one imports in any form (type imports included). */
  imported: string[];
}

/** A relative specifier's file, by path arithmetic only (fixtures resolve against paths that don't exist). */
function specPath(from: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  return posix.normalize(posix.join(posix.dirname(from), spec));
}
const stemOf = (p: string) => p.replace(/\.(ts|tsx|js|mjs|cjs|jsx)$/, "").replace(/\/index$/, "");
const sameModule = (spec: string | null, file: string) => spec !== null && stemOf(spec) === stemOf(file);
const fromAdapter = (spec: string | null) => spec !== null && spec.startsWith("server/harness/pi/");

/** A repo-relative import target's file on disk: as written, stem.{ts,tsx,js,mjs}, stem/index.ts. */
export function resolveOnDisk(root: string, target: string): string | null {
  const stem = target.replace(/\.(ts|tsx|js|mjs)$/, "");
  for (const c of [target,`${stem}.ts`, `${stem}.tsx`, `${stem}.js`, `${stem}.mjs`, `${stem}/index.ts`]) {
    const abs = join(root, c);
    if (existsSync(abs) && statSync(abs).isFile()) return c;
  }
  return null;
}

const kindOf = (path: string) =>
  path.endsWith(".tsx") ? ts.ScriptKind.TSX : path.endsWith(".jsx") ? ts.ScriptKind.JSX : /\.[cm]?js$/.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS;

const stringText = (n: ts.Node): string | null =>
  ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) ? n.text : null;

/** `x.type` / `x?.type` / `x["type"]`. */
function isTypeRead(n: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(n)) return n.name.text === "type";
  if (ts.isElementAccessExpression(n)) return stringText(n.argumentExpression) === "type";
  return false;
}

/** A member name read by `.name`, `["name"]` or destructuring `{ name }` (never a declaration). */
function memberRead(n: ts.Node): string | null {
  if (ts.isPropertyAccessExpression(n)) return n.name.text;
  if (ts.isElementAccessExpression(n)) return stringText(n.argumentExpression);
  if (ts.isBindingElement(n) && ts.isObjectBindingPattern(n.parent)) {
    const p = n.propertyName ?? n.name;
    return ts.isIdentifier(p) || ts.isStringLiteral(p) ? p.text : null;
  }
  return null;
}

function inTypePosition(n: ts.Node): boolean {
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if (ts.isTypeNode(p) || ts.isHeritageClause(p) || ts.isTypeAliasDeclaration(p) || ts.isInterfaceDeclaration(p)) return true;
    if (ts.isStatement(p) || ts.isBlock(p) || ts.isSourceFile(p)) return false;
  }
  return false;
}

/** An identifier that refers to a binding as a value: not a declaration name, a member name or a type. */
function isValueReference(id: ts.Identifier): boolean {
  const p = id.parent;
  if (!p) return false;
  if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isImportEqualsDeclaration(p) || ts.isExportSpecifier(p)) return false;
  if ((ts.isPropertyAccessExpression(p) || ts.isQualifiedName(p)) && (p as ts.PropertyAccessExpression).name === id) return false;
  if (ts.isBindingElement(p) && (p.name === id || p.propertyName === id)) return false;
  if (
    (ts.isVariableDeclaration(p) || ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isClassDeclaration(p) || ts.isParameter(p) ||
      ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isPropertySignature(p) || ts.isMethodDeclaration(p) ||
      ts.isMethodSignature(p) || ts.isGetAccessor(p) || ts.isSetAccessor(p) || ts.isEnumMember(p) || ts.isTypeAliasDeclaration(p) ||
      ts.isInterfaceDeclaration(p) || ts.isJsxAttribute(p)) &&
    (p as ts.NamedDeclaration).name === id
  ) return false;
  if (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return false;
  return !inTypePosition(id);
}

const FUNCTIONS = (n: ts.Node): n is ts.FunctionLikeDeclaration =>
  ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n);

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((e) => (ts.isOmittedExpression(e) ? [] : bindingNames(e.name)));
}

function functionName(f: ts.FunctionLikeDeclaration, src: ts.SourceFile): string {
  if (f.name && (ts.isIdentifier(f.name) || ts.isStringLiteral(f.name))) return f.name.text;
  const p = f.parent;
  if (p && (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p)) && ts.isIdentifier(p.name)) return p.name.text;
  return `<anonymous>@${src.getLineAndCharacterOfPosition(f.getStart(src)).line + 1}`;
}

/** Where a path sits: what the scan counts there. */
export function zoneOf(path: string): { scanned: boolean; counted: boolean; uiRules: boolean; typesOnly: boolean } {
  const inA = /^(server|shared|src)\//.test(path) && !isExcluded(path);
  const inB = path.startsWith("pi-config/");
  return {
    scanned: inA || inB,
    counted: inA && !isTest(path),
    uiRules: inA && !isTest(path) && /^(src|shared)\//.test(path),
    typesOnly: /^shared\/harness(-[a-z]+)?\.ts$/.test(path),
  };
}

/** Scans one file's text as if it sat at `path` (repo-relative). */
export function scanText(path: string, text: string): FileScan {
  const out: FileScan = { path, imports: null, importHits: [], calls: [], shapes: [], reaches: [], writers: [], wrappers: [], violations: [], edges: [], imported: [] };
  const zone = zoneOf(path);
  if (!zone.scanned) return out;
  const rawLayer = RAW_SOURCES.some((r) => sameModule(path, r));
  const src = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kindOf(path));
  const lineOf = (n: ts.Node) => src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1;
  const hit = (list: Hit[], rule: string, n: ts.Node) => list.push({ rule, line: lineOf(n) });
  const piHit = (kind: ImportKind, rule: string, n: ts.Node) => {
    out.importHits.push({ rule: `${kind}: ${rule}`, line: lineOf(n) });
    if (kind === "runtime" || out.imports === null) out.imports = kind;
  };

  // Import bindings this file tracks by name: raw API, pi's SessionManager, the bridges.
  const rawLocals = new Set<string>();
  const rawNamespaces = new Set<string>();
  const smLocals = new Set<string>();
  const bridgeLocals = new Set<string>();
  const bridgeNamespaces = new Set<string>();
  const specifiers = new Set<ts.Node>();

  for (const st of src.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const spec = st.moduleSpecifier.text;
      specifiers.add(st.moduleSpecifier);
      const c = st.importClause;
      const target = specPath(path, spec);
      const typeOnly = !!c && (c.isTypeOnly || (!c.name && !!c.namedBindings && ts.isNamedImports(c.namedBindings) && c.namedBindings.elements.length > 0 && c.namedBindings.elements.every((e) => e.isTypeOnly)));
      if (target) out.imported.push(target);
      if (PI.test(spec)) piHit(typeOnly ? "type" : "runtime", `import from "${spec}"`, st);
      if (target && !typeOnly) out.edges.push(target);
      const named = c?.namedBindings && ts.isNamedImports(c.namedBindings) ? c.namedBindings.elements : [];
      const ns = c?.namedBindings && ts.isNamespaceImport(c.namedBindings) ? c.namedBindings.name.text : null;
      if (!rawLayer && RAW_SOURCES.some((r) => sameModule(target, r))) {
        for (const e of named) if (RAW_API.includes((e.propertyName ?? e.name).text) && !e.isTypeOnly && !c!.isTypeOnly) rawLocals.add(e.name.text);
        if (ns) rawNamespaces.add(ns);
      }
      if (fromAdapter(target)) {
        for (const e of named) if (BRIDGES.includes((e.propertyName ?? e.name).text)) bridgeLocals.add(e.name.text);
        if (ns) bridgeNamespaces.add(ns);
      }
      if (PI.test(spec)) for (const e of named) if ((e.propertyName ?? e.name).text === "SessionManager") smLocals.add(e.name.text);
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
      const spec = st.moduleSpecifier.text;
      specifiers.add(st.moduleSpecifier);
      const target = specPath(path, spec);
      const typeOnly = st.isTypeOnly || (!!st.exportClause && ts.isNamedExports(st.exportClause) && st.exportClause.elements.every((e) => e.isTypeOnly));
      if (target) out.imported.push(target);
      if (PI.test(spec)) piHit(typeOnly ? "type" : "runtime", `export from "${spec}"`, st);
      if (target && !typeOnly) out.edges.push(target);
      const names = st.exportClause && ts.isNamedExports(st.exportClause) ? st.exportClause.elements.map((e) => (e.propertyName ?? e.name).text) : null;
      if (zone.counted && !rawLayer && RAW_SOURCES.some((r) => sameModule(target, r)) && (names === null || names.some((n) => RAW_API.includes(n))))
        out.violations.push({ code: "reexport", line: lineOf(st), message: "re-exports the transcript's raw API, which would hide every downstream call: import it where it is used" });
      if (zone.counted && fromAdapter(target) && (names === null || names.some((n) => BRIDGES.includes(n))))
        out.violations.push({ code: "reexport", line: lineOf(st), message: "re-exports an adapter bridge (liveRead/stateOf), which would hide every downstream reach: import it where it is used" });
    } else if (ts.isImportEqualsDeclaration(st) && ts.isExternalModuleReference(st.moduleReference) && ts.isStringLiteral(st.moduleReference.expression)) {
      specifiers.add(st.moduleReference.expression);
      const spec = st.moduleReference.expression.text;
      if (PI.test(spec)) piHit(st.isTypeOnly ? "type" : "runtime", `import = require("${spec}")`, st);
      const target = specPath(path, spec);
      if (target) out.imported.push(target);
      if (target && !st.isTypeOnly) out.edges.push(target);
    }
  }
  // `export { parseLines }` of a tracked import binding hides it the same way.
  if (zone.counted)
    for (const st of src.statements)
      if (ts.isExportDeclaration(st) && !st.moduleSpecifier && st.exportClause && ts.isNamedExports(st.exportClause))
        for (const e of st.exportClause.elements) {
          const local = (e.propertyName ?? e.name).text;
          if (rawLocals.has(local) || bridgeLocals.has(local))
            out.violations.push({ code: "reexport", line: lineOf(st), message: `re-exports ${local}, which would hide every downstream call: import it where it is used` });
        }

  const counted = zone.counted;
  const visit = (n: ts.Node): void => {
    // ---- pi imports, in every form beyond the declarations above.
    if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument) && ts.isStringLiteral(n.argument.literal)) {
      specifiers.add(n.argument.literal);
      if (PI.test(n.argument.literal.text)) piHit("type", `import("${n.argument.literal.text}") type`, n);
    }
    if (ts.isCallExpression(n) && n.arguments[0]) {
      const a = stringText(n.arguments[0]);
      const callee = n.expression;
      const dynamic = callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require");
      if (a !== null && dynamic) {
        const target = specPath(path, a);
        if (target) {
          out.imported.push(target);
          out.edges.push(target);
        }
      }
    }
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) && !specifiers.has(n)) {
      const t = n.text;
      if (PI.test(t)) piHit("runtime", `string "${t.length > 60 ? `${t.slice(0, 57)}…` : t}"`, n);
      if (counted) for (const _ of t.matchAll(JSON_SHAPE)) hit(out.shapes, "JSON-spelled pi entry field in a string", n);
    }

    if (counted) {
      // ---- readers: calls
      const member = memberRead(n);
      if (member !== null && RAW_NAMES.includes(member)) hit(out.calls, `${member}`, n);
      if (ts.isIdentifier(n) && isValueReference(n)) {
        if (RAW_NAMES.includes(n.text)) hit(out.calls, n.text, n);
        if (rawLocals.has(n.text)) hit(out.calls, `${n.text} (transcript raw API)`, n);
        if (smLocals.has(n.text)) hit(out.reaches, `${n.text} (pi SessionManager)`, n);
        if (bridgeLocals.has(n.text)) hit(out.reaches, `${n.text} (adapter bridge)`, n);
        if (WRITERS.includes(n.text)) hit(out.writers, n.text, n);
      }
      if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression)) {
        if (rawNamespaces.has(n.expression.text) && RAW_API.includes(n.name.text)) hit(out.calls, `${n.name.text} (transcript raw API)`, n);
        if (bridgeNamespaces.has(n.expression.text) && BRIDGES.includes(n.name.text)) hit(out.reaches, `${n.name.text} (adapter bridge)`, n);
      }
      // ---- readers: shapes
      if (member === "customType") hit(out.shapes, "customType read", n);
      if (ts.isBinaryExpression(n) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(n.operatorToken.kind)) {
        const [l, r] = [n.left, n.right];
        const lit = stringText(l) ?? stringText(r);
        const other = stringText(l) !== null ? r : l;
        if (lit !== null && PI_TYPES.includes(lit) && isTypeRead(other)) hit(out.shapes, `.type compared with "${lit}"`, n);
        if (zone.uiRules && lit !== null && PI_EVENTS.includes(lit)) hit(out.shapes, `pi event "${lit}" compared`, n);
      }
      if (ts.isCaseClause(n)) {
        const lit = stringText(n.expression);
        const sw = n.parent.parent;
        if (lit !== null && PI_TYPES.includes(lit) && ts.isSwitchStatement(sw) && isTypeRead(sw.expression)) hit(out.shapes, `case "${lit}" on .type`, n);
        if (zone.uiRules && lit !== null && PI_EVENTS.includes(lit)) hit(out.shapes, `case "${lit}" (pi event)`, n);
      }
      if (zone.uiRules && (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n))) {
        const o = n.expression;
        const throughMeta = (ts.isPropertyAccessExpression(o) && o.name.text === "meta") || (ts.isIdentifier(o) && o.text === "meta" && !!n.questionDotToken);
        if (throughMeta) hit(out.shapes, "read through .meta", n);
      }
      // ---- readers: reaches
      if (ts.isIdentifier(n) && n.text === "sessionManager") hit(out.reaches, "sessionManager", n);
      if (ts.isStringLiteral(n) && n.text === "sessionManager" && n.parent && ((ts.isElementAccessExpression(n.parent) && n.parent.argumentExpression === n) || (ts.isPropertyAssignment(n.parent) && n.parent.name === n)))
        hit(out.reaches, '"sessionManager"', n);
      if (member !== null && SM_MEMBERS.includes(member)) hit(out.reaches, `${member} (pi SessionManager member)`, n);
      // ---- writers
      if (member !== null && WRITERS.includes(member)) hit(out.writers, member, n);
      if (ts.isCallExpression(n) && n.arguments[0] && ts.isIdentifier(n.arguments[0])) {
        const callee = n.expression;
        const name = memberRead(callee) ?? (ts.isIdentifier(callee) ? callee.text : null);
        const arg = n.arguments[0].text;
        if (name !== null && WRITERS.includes(name))
          for (let p: ts.Node | undefined = n.parent; p; p = p.parent)
            if (FUNCTIONS(p) && p.parameters.some((q) => bindingNames(q.name).includes(arg))) {
              out.wrappers.push({ name: functionName(p, src), line: lineOf(p) });
              break;
            }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(src);

  if (zone.typesOnly) {
    const sibling = /^\.\/harness(-[a-z]+)?(\.ts)?$/;
    for (const st of src.statements) {
      const bad = (message: string) => out.violations.push({ code: "types-only", line: lineOf(st), message });
      if (ts.isImportDeclaration(st)) {
        const spec = (st.moduleSpecifier as ts.StringLiteral).text;
        if (!sibling.test(spec)) bad(`imports "${spec}": a contract file imports only its siblings`);
        else if (!st.importClause?.isTypeOnly) bad(`imports "${spec}" without \`import type\`: a contract file emits no code`);
      } else if (ts.isExportDeclaration(st)) {
        if (st.moduleSpecifier && !sibling.test((st.moduleSpecifier as ts.StringLiteral).text)) bad(`re-exports "${(st.moduleSpecifier as ts.StringLiteral).text}": only siblings`);
      } else if (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) {
        // types
      } else if ((ts.isVariableStatement(st) || ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isModuleDeclaration(st) || ts.isEnumDeclaration(st)) && st.modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) {
        // ambient: emits nothing
      } else bad(`declares ${ts.SyntaxKind[st.kind]}, which emits code: shared/harness*.ts hold types only`);
    }
  }
  return out;
}

// ---- The repository ------------------------------------------------------------------------------

/** Tracked and untracked-but-not-ignored files, so a new file counts before it is committed. */
export function listFiles(root: string): string[] {
  const out = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 });
  return [...new Set(out.split("\0").filter(Boolean))].filter((f) => existsSync(join(root, f))).sort();
}

export interface RepoScan {
  zoneA: string[];
  zoneB: string[];
  scans: Map<string, FileScan>;
  /** Zone-A importers of PI_ADAPTER_FILE. */
  adapterImporters: string[];
}

export function scanRepo(root: string, files = listFiles(root)): RepoScan {
  const scans = new Map<string, FileScan>();
  const scan = (f: string) => {
    let s = scans.get(f);
    if (!s) scans.set(f, (s = scanText(f, readFileSync(join(root, f), "utf8"))));
    return s;
  };
  const zoneA = files.filter((f) => CODE.test(f) && /^(server|shared|src)\//.test(f) && !isExcluded(f));
  for (const f of zoneA) scan(f);
  // Zone B: pi-config files reached at runtime from non-test Zone-A files, transitively.
  const onDisk = (target: string) => resolveOnDisk(root, target);
  const zoneB = new Set<string>();
  const queue: string[] = [];
  for (const f of zoneA.filter((f) => !isTest(f)))
    for (const t of scan(f).edges) {
      const r = onDisk(t);
      if (r && r.startsWith("pi-config/") && CODE.test(r) && !zoneB.has(r)) zoneB.add(r), queue.push(r);
    }
  while (queue.length) {
    const f = queue.shift()!;
    for (const t of scan(f).edges) {
      const r = onDisk(t);
      if (r && r.startsWith("pi-config/") && CODE.test(r) && !zoneB.has(r)) zoneB.add(r), queue.push(r);
    }
  }
  const adapterImporters = zoneA.filter((f) => scan(f).imported.some((t) => onDisk(t) === PI_ADAPTER_FILE));
  return { zoneA, zoneB: [...zoneB].sort(), scans, adapterImporters };
}

// ---- The baseline ---------------------------------------------------------------------------------

export interface Baseline {
  v: 1;
  note: string;
  imports: Record<string, ImportKind>;
  readers: Record<string, { calls: number; shapes: number; reaches: number }>;
  writers: Record<string, number>;
  wrappers: string[];
  piAdapter: string[];
}

export const BASELINE_NOTE = "Shrink-only (§app.harness/boundary). Never add a file, raise a count or list a wrapper; lower it in the change that removes a hit. Regenerate with SOVA_BOUNDARY_OUT=<abs path> pnpm test -- server/harness-boundary.test.ts.";

export function baselineOf(repo: RepoScan): Baseline {
  const b: Baseline = { v: 1, note: BASELINE_NOTE, imports: {}, readers: {}, writers: {}, wrappers: [], piAdapter: [...repo.adapterImporters] };
  for (const f of [...repo.zoneA, ...repo.zoneB].sort()) {
    const s = repo.scans.get(f)!;
    if (s.imports) b.imports[f] = s.imports;
    if (s.calls.length || s.shapes.length || s.reaches.length) b.readers[f] = { calls: s.calls.length, shapes: s.shapes.length, reaches: s.reaches.length };
    if (s.writers.length) b.writers[f] = s.writers.length;
    for (const w of s.wrappers) b.wrappers.push(`${f}:${w.name}`);
  }
  b.wrappers = [...new Set(b.wrappers)].sort();
  return b;
}

/** Sorted keys, one entry per line, so a baseline diff reads one file per line. */
export function formatBaseline(b: Baseline): string {
  const obj = (o: Record<string, unknown>) => {
    const keys = Object.keys(o).sort();
    return keys.length ? `{\n${keys.map((k) => `    ${JSON.stringify(k)}: ${JSON.stringify(o[k]).replace(/,"/g, ', "').replace(/":/g, '": ')}`).join(",\n")}\n  }` : "{}";
  };
  const arr = (a: string[]) => (a.length ? `[\n${[...a].sort().map((x) => `    ${JSON.stringify(x)}`).join(",\n")}\n  ]` : "[]");
  return `{\n  "v": 1,\n  "note": ${JSON.stringify(b.note)},\n  "imports": ${obj(b.imports)},\n  "readers": ${obj(b.readers)},\n  "writers": ${obj(b.writers)},\n  "wrappers": ${arr(b.wrappers)},\n  "piAdapter": ${arr(b.piAdapter)}\n}\n`;
}

/** Growth from `before` to `after`: a new key, a higher count, a type entry turned runtime. */
export function growth(before: Baseline, after: Baseline): string[] {
  const out: string[] = [];
  for (const [f, k] of Object.entries(after.imports)) {
    if (!(f in before.imports)) out.push(`imports: ${f} added`);
    else if (before.imports[f] === "type" && k === "runtime") out.push(`imports: ${f} type → runtime`);
  }
  for (const [f, r] of Object.entries(after.readers)) {
    const was = before.readers[f];
    if (!was) out.push(`readers: ${f} added`);
    else for (const c of ["calls", "shapes", "reaches"] as const) if (r[c] > (was[c] ?? 0)) out.push(`readers: ${f} ${c} ${was[c] ?? 0} → ${r[c]}`);
  }
  for (const [f, n] of Object.entries(after.writers)) {
    if (!(f in before.writers)) out.push(`writers: ${f} added`);
    else if (n > before.writers[f]!) out.push(`writers: ${f} ${before.writers[f]} → ${n}`);
  }
  for (const w of after.wrappers) if (!before.wrappers.includes(w)) out.push(`wrappers: ${w} added`);
  for (const w of after.piAdapter ?? []) if (!(before.piAdapter ?? []).includes(w)) out.push(`piAdapter: ${w} added`);
  return out;
}

// ---- The runner's file patterns -------------------------------------------------------------------

/** `const GLOBS = [ "…", … ]` from scripts/run-tests.mjs, read by AST (importing it would run the suite). */
export function runnerGlobs(text: string): string[] {
  const src = ts.createSourceFile("run-tests.mjs", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  for (const st of src.statements)
    if (ts.isVariableStatement(st))
      for (const d of st.declarationList.declarations)
        if (ts.isIdentifier(d.name) && d.name.text === "GLOBS" && d.initializer && ts.isArrayLiteralExpression(d.initializer))
          return d.initializer.elements.map((e) => {
            if (!ts.isStringLiteral(e)) throw new Error("GLOBS holds something other than string literals");
            return e.text;
          });
  throw new Error("no `const GLOBS = [...]` in scripts/run-tests.mjs");
}

export function globRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    if (glob.startsWith("**/", i)) (re += "(?:.*/)?"), (i += 2);
    else if (glob[i] === "*") re += "[^/]*";
    else re += glob[i]!.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}
