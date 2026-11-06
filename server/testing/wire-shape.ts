import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import type { AreaId } from "../../shared/wire-areas";

// What the ratchet in shared/wire-areas.test.ts holds each area against (§mesh.compatibility/declare-
// a-change): the area's root types expanded through the compiler, so a reworded comment or a reordered
// declaration changes nothing and any change to a field does. It only reports a difference: nothing
// here decides whether that difference breaks anyone.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** One root: a file under the repository and the type it declares there. */
export type AreaRoot = [file: string, type: string];

const PROTOCOL = "shared/protocol.ts";
const LINKS = "shared/mesh-links.ts";
const DETAILS = "shared/mesh-details.ts";
const HARNESS = "shared/harness-wire.ts";
const AREAS = "shared/wire-areas.ts";

export const AREA_ROOTS: Record<AreaId, AreaRoot[]> = {
  sessions: [
    [PROTOCOL, "SessionSummary"],
    [PROTOCOL, "MeshSessions"],
  ],
  transcript: [
    [PROTOCOL, "TranscriptItem"],
    [PROTOCOL, "TranscriptRows"],
    [PROTOCOL, "ChatServerMessage"],
    [PROTOCOL, "WatchServerMessage"],
    [PROTOCOL, "V1EventFrame"],
    [PROTOCOL, "V2EventFrame"],
    [HARNESS, "SovaEvent"],
    [HARNESS, "SovaPart"],
    [HARNESS, "RowFacts"],
  ],
  composer: [
    [PROTOCOL, "ChatClientMessage"],
    [AREAS, "NewSessionBody"],
    [AREAS, "SessionPromptBody"],
    [LINKS, "SessionConfigure"],
    ["server/chat-actions.ts", "ChatAction"],
  ],
  peer: [
    [LINKS, "PeerLinkCopy"],
    [LINKS, "PeerLinkEnd"],
    [LINKS, "PeerLinkEndResult"],
    [LINKS, "PeerLinkMessage"],
    [LINKS, "PeerLinkMessageResult"],
    [LINKS, "LinkWhoami"],
    [LINKS, "PeerLinkRead"],
    [LINKS, "PeerLinkOffer"],
    [LINKS, "PeerLinkOfferResult"],
    [LINKS, "PeerOfferReport"],
    [DETAILS, "HostDetails"],
    [DETAILS, "HostRename"],
    [DETAILS, "HostTold"],
    [DETAILS, "HostRenameResult"],
    [DETAILS, "HostBrowserAccess"],
    [DETAILS, "HostBrowserAccessChange"],
    [DETAILS, "HostBrowserAccessResult"],
    ["server/sync/docs.ts", "DocManifest"],
    ["server/sync/docs.ts", "DocReply"],
    ["server/sync/docs.ts", "DocPush"],
    ["server/sync/docs.ts", "DocPushReply"],
    ["server/sync/extensions.ts", "ExtensionList"],
    ["server/sync/logins.ts", "CredentialManifest"],
    ["server/sync/logins.ts", "CredentialPush"],
    ["server/sync/logins.ts", "CredentialPushReply"],
    ["server/sync/logins.ts", "CredentialEntryReply"],
  ],
};

const OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  allowImportingTsExtensions: true,
  resolveJsonModule: true,
  types: ["node"],
};

/** Text instead of a file: a test's change to a real source, or a whole made-up one. */
export type Overrides = ReadonlyMap<string, string>;

/** Parsed files, shared by the programs of one run: parsing is nearly all of a program's cost. */
const parsed = new Map<string, ts.SourceFile>();

/** A compiler over `files` (repository-relative), reading `overrides` in place of what is on disk. */
export function shapeProgram(files: readonly string[], overrides: Overrides = new Map()): ts.Program {
  const byPath = new Map([...overrides].map(([file, text]) => [join(ROOT, file), text]));
  const host = ts.createCompilerHost(OPTIONS, true);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.readFile = (path) => byPath.get(path) ?? readFile(path);
  host.fileExists = (path) => byPath.has(path) || fileExists(path);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (path, language, ...rest) => {
    const text = byPath.get(path);
    if (text !== undefined) return ts.createSourceFile(path, text, language, true);
    let file = parsed.get(path);
    if (!file) {
      file = getSourceFile(path, language, ...rest);
      if (file) parsed.set(path, file);
    }
    return file;
  };
  return ts.createProgram({ rootNames: files.map((f) => join(ROOT, f)), options: OPTIONS, host });
}

/** Declared in TypeScript's own library: a name is enough (Date, Map, Promise). */
const isLibrary = (program: ts.Program, symbol: ts.Symbol | undefined): boolean => {
  const decl = symbol?.declarations?.[0];
  return !!decl && program.isSourceFileDefaultLibrary(decl.getSourceFile());
};

/** The canonical text of `roots`: every named object once, under its name, fields sorted. */
export function shapeText(program: ts.Program, roots: readonly AreaRoot[]): string {
  const checker = program.getTypeChecker();
  /** Named object types by their name, finished or still being expanded. */
  const named = new Map<string, string>();
  const at = program.getSourceFiles()[0]!;

  const nameOf = (type: ts.Type): string | null => {
    const alias = type.aliasSymbol;
    const symbol = alias ?? type.getSymbol();
    if (!symbol || symbol.name.startsWith("__")) return null;
    const args = alias ? type.aliasTypeArguments : ((type as ts.TypeReference).typeArguments ?? []);
    return args?.length ? `${symbol.name}<${args.map((a) => expand(a, [])).join(",")}>` : symbol.name;
  };

  function objectBody(type: ts.Type, stack: readonly ts.Type[]): string {
    const calls = type.getCallSignatures().length || type.getConstructSignatures().length ? ["(fn)"] : [];
    const fields = checker
      .getPropertiesOfType(type)
      .slice()
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((p) => {
        const optional = p.flags & ts.SymbolFlags.Optional ? "?" : "";
        return `${p.name}${optional}:${expand(checker.getTypeOfSymbolAtLocation(p, p.valueDeclaration ?? at), stack)}`;
      });
    const indexes = checker.getIndexInfosOfType(type).map((i) => `[${expand(i.keyType, stack)}]:${expand(i.type, stack)}`);
    return `{${[...calls, ...indexes.sort(), ...fields].join(";")}}`;
  }

  function expand(type: ts.Type, stack: readonly ts.Type[]): string {
    if (type.flags & ts.TypeFlags.Boolean) return "boolean";
    if (type.isUnion()) return [...new Set(type.types.map((t) => expand(t, stack)))].sort().join("|");
    if (type.flags & ts.TypeFlags.Intersection) {
      const parts = (type as ts.IntersectionType).types;
      if (!parts.every((t) => t.flags & ts.TypeFlags.Object)) return [...new Set(parts.map((t) => expand(t, stack)))].sort().join("&");
      return objectBody(type, stack);
    }
    if (!(type.flags & ts.TypeFlags.Object)) return checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation);
    if (checker.isArrayType(type)) return `${expand(checker.getTypeArguments(type as ts.TypeReference)[0]!, stack)}[]`;
    if (checker.isTupleType(type)) return `[${checker.getTypeArguments(type as ts.TypeReference).map((t) => expand(t, stack)).join(",")}]`;
    if (isLibrary(program, type.getSymbol())) return type.getSymbol()!.name;
    const depth = stack.indexOf(type);
    if (depth >= 0) return `^${stack.length - depth}`;
    const name = nameOf(type);
    if (name === null) return objectBody(type, [...stack, type]);
    if (!named.has(name)) {
      named.set(name, "");
      named.set(name, objectBody(type, []));
    }
    return `@${name}`;
  }

  const lines = roots.map(([file, name]) => {
    const source = program.getSourceFile(join(ROOT, file));
    if (!source) throw new Error(`${file} isn't in the program`);
    const symbol = checker.getExportsOfModule(checker.getSymbolAtLocation(source)!).find((s) => s.name === name);
    if (!symbol) throw new Error(`${file} exports no type ${name}`);
    return `${name}=${expand(checker.getDeclaredTypeOfSymbol(symbol), [])}`;
  });
  return [...lines.sort(), ...[...named].map(([name, body]) => `@${name}=${body}`).sort()].join("\n");
}

export const shapeHash = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** Every area's shape as the code has it now (or with `overrides` in its place). */
export function areaShapes(overrides?: Overrides): Record<AreaId, string> {
  const files = [...new Set(Object.values(AREA_ROOTS).flatMap((roots) => roots.map(([file]) => file)))];
  const program = shapeProgram(files, overrides);
  return Object.fromEntries(Object.entries(AREA_ROOTS).map(([area, roots]) => [area, shapeHash(shapeText(program, roots))])) as Record<AreaId, string>;
}
