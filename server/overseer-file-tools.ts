import { spawn } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  DEFAULT_MAX_BYTES,
  detectSupportedImageMimeTypeFromFile,
  formatSize,
  truncateHead,
  truncateLine,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type RootConfinement, SecretGuard, WriteGuard } from "./overseer-deny";
import { type Redactor, redactingTool, serverRedactor } from "./overseer-redact";
import { reservedRoots } from "./projects/contributions";
import { agentRoot, stateRoot } from "./state-root";

/**
 * The Overseer's read, grep, find and ls: pi's own tools, except that no secret file
 * (overseer-deny.ts) is ever read, listed or matched. A path argument that names one is refused
 * with SECRET_REFUSAL, and a search or listing from a parent directory leaves them out of its
 * results. A secret value found anywhere else (a copy, a log line) comes back as `[redacted]`
 * (redactingTool, overseer-redact.ts). They are registered as the session's custom tools, which take precedence over the
 * built-ins and over any extension's tool of the same name; other sessions keep pi's tools.
 *
 * read, ls and find keep pi's execute and run every path through their `operations` hook, which
 * receives the absolute path pi resolved (including read's unicode variants). grep can't: pi's grep
 * formats ripgrep's matches itself, so this one runs ripgrep the same way and drops secret files'
 * matches before formatting them.
 *
 * With `confine` (the project overseer's), every path is also held to a root: a path argument
 * outside it (or in an excluded folder) is refused, and listings and searches leave such entries
 * out, exactly as they do secret files. Its read-only folders (RootConfinement's `readable`) open to
 * read alone.
 */
export function overseerFileTools(
  cwd: string,
  secrets: () => SecretGuard = () => new SecretGuard(),
  redactor: () => Redactor = serverRedactor,
  confine?: () => RootConfinement,
  writes?: FileWrites,
): ToolDefinition[] {
  // `forRead`: the confinement's read-only folders open too (read's guard only).
  const guard = (forRead = false): PathGuard => {
    const s = secrets();
    const c = confine?.();
    if (!c) return s;
    const problem = (p: string) => (forRead ? c.readProblem(p) : c.problem(p));
    return {
      check: (p) => {
        const why = problem(p);
        if (why) throw new Error(why);
        s.check(p);
      },
      isSecret: (p) => problem(p) !== null || s.isSecret(p),
    };
  };
  const read = createReadToolDefinition(cwd);
  const find = createFindToolDefinition(cwd);
  const ls = createLsToolDefinition(cwd);
  const grep = createGrepToolDefinition(cwd);
  return [
    {
      ...read,
      // A fresh guard per call: the rules resolve symlinks, which may have changed.
      execute: (...args: Parameters<typeof read.execute>) => {
        const g = guard(true);
        return createReadToolDefinition(cwd, {
          operations: {
            access: async (p) => (g.check(p), access(p, constants.R_OK)),
            readFile: async (p) => (g.check(p), readFile(p)),
            detectImageMimeType: async (p) => (g.check(p), detectSupportedImageMimeTypeFromFile(p)),
          },
        }).execute(...args);
      },
    },
    {
      ...ls,
      execute: (...args: Parameters<typeof ls.execute>) => {
        const g = guard();
        return createLsToolDefinition(cwd, {
          operations: {
            exists: async (p) => (g.check(p), existsSync(p)),
            stat: async (p) => (g.check(p), stat(p)),
            readdir: async (dir) => (await readdir(dir)).filter((name) => !g.isSecret(join(dir, name))),
          },
        }).execute(...args);
      },
    },
    {
      ...find,
      execute: (...args: Parameters<typeof find.execute>) => {
        const g = guard();
        return createFindToolDefinition(cwd, {
          operations: {
            exists: async (p) => (g.check(p), existsSync(p)),
            glob: (pattern, searchPath, { ignore, limit }) => fdGlob(pattern, searchPath, ignore, limit, g),
          },
        }).execute(...args);
      },
    },
    { ...grep, execute: (_id, params, signal, _onUpdate, ctx) => guardedGrep(params as GrepParams, ctx?.cwd || cwd, signal, guard()) } as ToolDefinition,
    ...(writes ? writeTools(cwd, writes, () => new WriteGuard(secrets(), writes.protectedRoots(), confine?.())) : []),
    // Their output is redacted; their arguments (paths, a pattern, a file's content) are left as given:
    // a redacted content or oldText would write or match something else.
  ].map((t) => redactingTool(t as ToolDefinition, redactor, { args: false }));
}

/** Sova's and pi's own state, which no write reaches: the agent dir (the state root is inside it,
    named too in case it ever moves), `~/.pi`, and the folders a project layer reserves (an attached
    org's workspace). Read per call: an org attached since counts. */
export const ownStateRoots = (): string[] => [agentRoot(), stateRoot(), join(homedir(), ".pi"), ...reservedRoots()];

/** What write and edit need beyond the read rules (§app.overseer/tools, §app.project-overseer/tools). */
export interface FileWrites {
  /** Folders no write reaches, whatever the read rules allow: Sova's and pi's state, reserved roots. */
  protectedRoots(): string[];
  /** The run is the user's (the operator's): a write runs only then. */
  attended(): boolean;
  /** The refusal in any other run. */
  unattended: string;
  /** One action-log line per call, refused or not: the path and the bytes written, never the content. */
  log(line: { toolCallId: string; tool: string; args: { path?: string; bytes?: number }; outcome: "ok" | "refused" | "error"; error?: string }): void;
}

/** pi's write and edit, each path through `guard()` (fresh per call: symlinks may have changed). */
function writeTools(cwd: string, writes: FileWrites, guard: () => WriteGuard): ToolDefinition[] {
  const write = createWriteToolDefinition(cwd);
  const edit = createEditToolDefinition(cwd);
  /** Runs one call: refused unattended, every path checked, logged once. pi may wrap an operation's
      error in its own sentence; a refusal comes back as the guard said it. */
  const guarded =
    (name: string, run: (g: (p: string) => void, wrote: (bytes: number) => void, args: unknown[]) => Promise<unknown>) =>
    async (...args: unknown[]) => {
      const params = args[1] as { path?: unknown } | undefined;
      const path = typeof params?.path === "string" ? params.path : undefined;
      let refusal: string | null = null;
      let bytes: number | undefined;
      const log = (outcome: "ok" | "refused" | "error", error?: string) =>
        writes.log({ toolCallId: String(args[0] ?? ""), tool: name, args: { ...(path !== undefined ? { path } : {}), ...(bytes !== undefined ? { bytes } : {}) }, outcome, ...(error !== undefined ? { error } : {}) });
      try {
        if (!writes.attended()) {
          refusal = writes.unattended;
          throw new Error(refusal);
        }
        const g = guard();
        const check = (p: string) => {
          const why = g.problem(p);
          if (why) {
            refusal = why;
            throw new Error(why);
          }
        };
        if (path !== undefined) check(resolveArg(path, (args[4] as { cwd?: string } | undefined)?.cwd || cwd));
        const out = await run(check, (n) => (bytes = n), args);
        log("ok");
        return out;
      } catch (err) {
        if (refusal) {
          log("refused", refusal);
          throw new Error(refusal);
        }
        const message = err instanceof Error ? err.message : String(err);
        log("error", message);
        throw err instanceof Error ? err : new Error(message);
      }
    };
  return [
    {
      ...write,
      execute: guarded("write", (check, wrote, args) =>
        createWriteToolDefinition(cwd, {
          operations: {
            mkdir: async (dir) => (check(dir), void (await mkdir(dir, { recursive: true }))),
            writeFile: async (p, content) => (check(p), await writeFile(p, content, "utf-8"), wrote(Buffer.byteLength(content))),
          },
        }).execute(...(args as Parameters<typeof write.execute>)),
      ),
    } as ToolDefinition,
    {
      ...edit,
      execute: guarded("edit", (check, wrote, args) =>
        createEditToolDefinition(cwd, {
          operations: {
            access: async (p) => (check(p), access(p, constants.R_OK | constants.W_OK)),
            readFile: async (p) => (check(p), readFile(p)),
            writeFile: async (p, content) => (check(p), await writeFile(p, content, "utf-8"), wrote(Buffer.byteLength(content))),
          },
        }).execute(...(args as Parameters<typeof edit.execute>)),
      ),
    } as ToolDefinition,
  ];
}

/** What the tools ask of a path: refuse it (`check`), or leave it out of a result (`isSecret`). */
type PathGuard = Pick<SecretGuard, "check" | "isSecret">;

/** pi's path argument rule (`@` stripped, `~` expanded, relative to cwd). */
function resolveArg(p: string, cwd: string): string {
  let s = p.startsWith("@") ? p.slice(1) : p;
  if (s === "~") s = homedir();
  else if (s.startsWith("~/")) s = join(homedir(), s.slice(2));
  return isAbsolute(s) ? resolve(s) : resolve(cwd, s);
}

/** Starts fd and rg; tests run them in-process instead (setSearchSpawnForTest). */
let spawnSearch: typeof spawn = spawn;
/** Tests: start fd and rg with `fn` (server/search-tools-fake.ts); null: the real programs again. */
export function setSearchSpawnForTest(fn: typeof spawn | null): void {
  spawnSearch = fn ?? spawn;
}

/** The binary pi would run: its own download in the agent dir, else the one on PATH. */
function toolBinary(name: "rg" | "fd"): string {
  const local = join(agentRoot(), "bin", name);
  return existsSync(local) ? local : name;
}

/** pi's find, through fd with pi's arguments, secret files left out (and not counted against the limit). */
async function fdGlob(pattern: string, searchPath: string, ignore: string[], limit: number, g: PathGuard): Promise<string[]> {
  const args = ["--glob", "--color=never", "--hidden", "--absolute-path"];
  for (const i of ignore) args.push("--exclude", i.replace(/^\*\*\//, "").replace(/\/\*\*$/, ""));
  let inGit = false;
  for (let cur = searchPath; ; ) {
    if (existsSync(join(cur, ".git"))) {
      inGit = true;
      break;
    }
    const up = resolve(cur, "..");
    if (up === cur) break;
    cur = up;
  }
  if (!inGit) args.push("--no-require-git");
  let effective = pattern;
  if (pattern.includes("/")) {
    args.push("--full-path");
    if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") effective = `**/${pattern}`;
  }
  args.push("--", effective, searchPath);
  return new Promise((done, fail) => {
    const child = spawnSearch(toolBinary("fd"), args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: string[] = [];
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += String(c)));
    createInterface({ input: child.stdout }).on("line", (line) => {
      const p = line.replace(/\r$/, "").trim();
      if (!p || out.length >= limit) return;
      if (g.isSecret(p.replace(/\/$/, ""))) return;
      out.push(p);
      if (out.length >= limit) child.kill();
    });
    child.on("error", (err) => fail(new Error(`fd is not available: ${err.message}`)));
    child.on("close", (code) => (code === 0 || out.length > 0 || child.killed ? done(out) : fail(new Error(stderr.trim() || `fd exited with code ${code}`))));
  });
}

type GrepParams = { pattern: string; path?: string; glob?: string; ignoreCase?: boolean; literal?: boolean; context?: number; limit?: number };

/** pi's grep (same arguments, same output), with secret files' matches dropped before they count. */
async function guardedGrep(p: GrepParams, cwd: string, signal: AbortSignal | undefined, g: PathGuard) {
  const searchPath = resolveArg(p.path || ".", cwd);
  g.check(searchPath);
  let isDir: boolean;
  try {
    isDir = (await stat(searchPath)).isDirectory();
  } catch {
    throw new Error(`Path not found: ${searchPath}`);
  }
  const context = p.context && p.context > 0 ? p.context : 0;
  const limit = Math.max(1, p.limit ?? 100);
  const args = ["--json", "--line-number", "--color=never", "--hidden"];
  if (p.ignoreCase) args.push("--ignore-case");
  if (p.literal) args.push("--fixed-strings");
  if (p.glob) args.push("--glob", p.glob);
  args.push("--", p.pattern, searchPath);

  const matches: { file: string; line: number; text?: string }[] = [];
  const secret = new Map<string, boolean>();
  let limitReached = false;
  await new Promise<void>((done, fail) => {
    const child = spawnSearch(toolBinary("rg"), args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let stopped = false;
    const onAbort = () => {
      stopped = true;
      child.kill();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stderr.on("data", (c) => (stderr += String(c)));
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (matches.length >= limit) return;
      let ev: { type?: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } } };
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      const file = ev.data?.path?.text;
      if (ev.type !== "match" || !file || typeof ev.data?.line_number !== "number") return;
      if (!secret.has(file)) secret.set(file, g.isSecret(file));
      if (secret.get(file)) return;
      matches.push({ file, line: ev.data.line_number, text: ev.data.lines?.text });
      if (matches.length >= limit) {
        limitReached = true;
        stopped = true;
        child.kill();
      }
    });
    child.on("error", (err) => fail(new Error(`Failed to run ripgrep: ${err.message}`)));
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) return fail(new Error("Operation aborted"));
      if (!stopped && code !== 0 && code !== 1) return fail(new Error(stderr.trim() || `ripgrep exited with code ${code}`));
      done();
    });
  });
  if (matches.length === 0) return { content: [{ type: "text" as const, text: "No matches found" }], details: undefined };

  const shown = (file: string) => {
    if (isDir) {
      const rel = relative(searchPath, file);
      if (rel && !rel.startsWith("..")) return rel.replace(/\\/g, "/");
    }
    return file.split("/").pop() ?? file;
  };
  let linesTruncated = false;
  const cut = (s: string) => {
    const t = truncateLine(s.replace(/\r/g, ""));
    if (t.wasTruncated) linesTruncated = true;
    return t.text;
  };
  const cache = new Map<string, string[]>();
  const out: string[] = [];
  for (const m of matches) {
    if (context === 0 && m.text !== undefined) {
      out.push(`${shown(m.file)}:${m.line}: ${cut(m.text.replace(/\r\n/g, "\n").replace(/\n$/, ""))}`);
      continue;
    }
    let lines = cache.get(m.file);
    if (!lines) {
      lines = await readFile(m.file, "utf8").then((t) => t.replace(/\r\n?/g, "\n").split("\n"), () => []);
      cache.set(m.file, lines);
    }
    if (!lines.length) {
      out.push(`${shown(m.file)}:${m.line}: (unable to read file)`);
      continue;
    }
    for (let n = Math.max(1, m.line - context); n <= Math.min(lines.length, m.line + context); n++)
      out.push(n === m.line ? `${shown(m.file)}:${n}: ${cut(lines[n - 1] ?? "")}` : `${shown(m.file)}-${n}- ${cut(lines[n - 1] ?? "")}`);
  }
  const truncation = truncateHead(out.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
  let text = truncation.content;
  const details: Record<string, unknown> = {};
  const notices: string[] = [];
  if (limitReached) {
    notices.push(`${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`);
    details.matchLimitReached = limit;
  }
  if (truncation.truncated) {
    notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
    details.truncation = truncation;
  }
  if (linesTruncated) {
    notices.push("Some lines truncated. Use read tool to see full lines");
    details.linesTruncated = true;
  }
  if (notices.length) text += `\n\n[${notices.join(". ")}]`;
  return { content: [{ type: "text" as const, text }], details: Object.keys(details).length ? details : undefined };
}
