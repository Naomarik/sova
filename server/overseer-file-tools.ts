import { spawn } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  DEFAULT_MAX_BYTES,
  detectSupportedImageMimeTypeFromFile,
  formatSize,
  getAgentDir,
  truncateHead,
  truncateLine,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { SecretGuard } from "./overseer-deny";

/**
 * The Overseer's read, grep, find and ls: pi's own tools, except that no secret file
 * (overseer-deny.ts) is ever read, listed or matched. A path argument that names one is refused
 * with SECRET_REFUSAL, and a search or listing from a parent directory leaves them out of its
 * results. They are registered as the session's custom tools, which take precedence over the
 * built-ins and over any extension's tool of the same name; other sessions keep pi's tools.
 *
 * read, ls and find keep pi's execute and run every path through their `operations` hook, which
 * receives the absolute path pi resolved (including read's unicode variants). grep can't: pi's grep
 * formats ripgrep's matches itself, so this one runs ripgrep the same way and drops secret files'
 * matches before formatting them.
 */
export function overseerFileTools(cwd: string, guard: () => SecretGuard = () => new SecretGuard()): ToolDefinition[] {
  const read = createReadToolDefinition(cwd);
  const find = createFindToolDefinition(cwd);
  const ls = createLsToolDefinition(cwd);
  const grep = createGrepToolDefinition(cwd);
  return [
    {
      ...read,
      // A fresh guard per call: the rules resolve symlinks, which may have changed.
      execute: (...args: Parameters<typeof read.execute>) => {
        const g = guard();
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
  ] as ToolDefinition[];
}

/** pi's path argument rule (`@` stripped, `~` expanded, relative to cwd). */
function resolveArg(p: string, cwd: string): string {
  let s = p.startsWith("@") ? p.slice(1) : p;
  if (s === "~") s = homedir();
  else if (s.startsWith("~/")) s = join(homedir(), s.slice(2));
  return isAbsolute(s) ? resolve(s) : resolve(cwd, s);
}

/** The binary pi would run: its own download in the agent dir, else the one on PATH. */
function toolBinary(name: "rg" | "fd"): string {
  const local = join(getAgentDir(), "bin", name);
  return existsSync(local) ? local : name;
}

/** pi's find, through fd with pi's arguments, secret files left out (and not counted against the limit). */
async function fdGlob(pattern: string, searchPath: string, ignore: string[], limit: number, g: SecretGuard): Promise<string[]> {
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
    const child = spawn(toolBinary("fd"), args, { stdio: ["ignore", "pipe", "pipe"] });
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
async function guardedGrep(p: GrepParams, cwd: string, signal: AbortSignal | undefined, g: SecretGuard) {
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
    const child = spawn(toolBinary("rg"), args, { stdio: ["ignore", "pipe", "pipe"] });
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
