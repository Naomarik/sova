// The project's own setup definition as the source sends it with the dialog's needs request
// (§app.transport/dialog): which of the files that name a project's tools are at its root, the
// programs its .sova/project.json runs and the tools its mise.toml names, and the host values it
// declares. Read only, on both sides: the source reads files and runs nothing; the destination
// checks the programs and host values against itself before the project is there, never running a
// project command.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONTRACT_FILE, parseDefinition } from "../../shared/project-contract";

export interface SetupDef {
  /** Which of MARKER_FILES are at the project's root (what projectNeeds reads). */
  files: string[];
  /** Programs its definition runs (setup steps, services, container engines) and the tools its mise.toml names. */
  programs: string[];
  /** The host values its definition declares (`host`): each this computer's own. */
  host: string[];
}

/** The files at a project's root that say what it needs (server/transport/agent.ts projectNeeds reads them). */
export const MARKER_FILES = [
  "mise.toml",
  ".mise.toml",
  ".tool-versions",
  "package.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "Cargo.toml",
  "go.mod",
  "deps.edn",
  "project.clj",
  "bb.edn",
  "Gemfile",
  "pyproject.toml",
  "requirements.txt",
  "mix.exs",
  "pom.xml",
  CONTRACT_FILE,
] as const;

const PROGRAM = /^[A-Za-z0-9][\w.+-]{0,63}$/;
const HOST = /^[A-Z_][A-Z0-9_]{0,127}$/;
const MAX = 40;

const uniq = (xs: Iterable<string>, ok: RegExp): string[] => [...new Set([...xs].filter((x) => ok.test(x)))].slice(0, MAX);

/** The tool names of a mise.toml's [tools] table (`java = "21"` → java; a backend's `npm:x` or `ubi:x` is no program). Pure. */
export function miseTools(text: string): string[] {
  const out: string[] = [];
  let inTools = false;
  for (const raw of text.split("\n")) {
    const l = raw.replace(/#.*$/, "").trim();
    if (!l) continue;
    if (l.startsWith("[")) {
      inTools = l === "[tools]";
      continue;
    }
    const m = inTools ? /^"?([A-Za-z0-9][\w.+-]*)"?\s*=/.exec(l) : null;
    if (m) out.push(m[1]!);
  }
  return out;
}

/** The setup definition of the project whose root is `root`, read from its files; null when nothing there names one. */
export function readSetupDef(root: string): SetupDef | null {
  const files = MARKER_FILES.filter((f) => existsSync(join(root, f)));
  const programs: string[] = [];
  let host: string[] = [];
  if (files.includes(CONTRACT_FILE)) {
    try {
      const def = parseDefinition(readFileSync(join(root, CONTRACT_FILE), "utf8"));
      for (const s of def.setup) programs.push(s.run[0]!);
      for (const s of def.services) {
        if (s.cmd) programs.push(s.cmd[0]!);
        if (s.container) programs.push(s.container.engine);
      }
      host = def.host;
    } catch {
      // an unreadable definition names nothing here; its doctor says why there
    }
  }
  for (const f of ["mise.toml", ".mise.toml"]) {
    if (!files.includes(f as (typeof MARKER_FILES)[number])) continue;
    try {
      programs.push(...miseTools(readFileSync(join(root, f), "utf8")));
    } catch {
      // unreadable: its tools go unnamed
    }
  }
  const out = { files: [...files], programs: uniq(programs, PROGRAM), host: uniq(host, HOST) };
  return out.files.length || out.programs.length || out.host.length ? out : null;
}

/** A setup definition as another device sent it, kept to plain names (programs, host values, known files); null: none. Pure. */
export function cleanSetupDef(v: unknown): SetupDef | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const list = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);
  const known = new Set<string>(MARKER_FILES);
  return { files: [...new Set(list(o.files).filter((f) => known.has(f)))], programs: uniq(list(o.programs), PROGRAM), host: uniq(list(o.host), HOST) };
}
