import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { PassThrough } from "node:stream";

/**
 * Tests only (nothing in the server imports this). fd and rg in-process, for the Overseer's find
 * and grep (`setSearchSpawnForTest`, server/overseer-file-tools.ts): the arguments those tools pass,
 * over the real files, printed as the programs print them. Hidden files are searched, symlinks below
 * the search path are not followed, and no ignore file is read; nothing else of the programs is
 * copied. What the guard above them does with the output is the code under test; the real fd and rg
 * are run by overseer-file-tools.integration.test.ts.
 */
export function fakeSearchSpawn(): typeof spawn {
  return ((command: string, args: readonly string[]) => {
    const name = basename(command);
    const run = name === "rg" ? rg : name === "fd" ? fd : null;
    if (!run) throw new Error(`the search fake runs fd and rg, not ${command}`);
    return child(() => run([...args]));
  }) as unknown as typeof spawn;
}

/** A finished program as a child process: its lines on stdout, then close with its code. */
function child(run: () => { lines: string[]; code: number; stderr?: string }): ChildProcess {
  const c = new EventEmitter() as ChildProcess & EventEmitter;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let killed = false;
  Object.assign(c, {
    stdout,
    stderr,
    get killed() {
      return killed;
    },
    kill: () => {
      killed = true;
      return true;
    },
  });
  setImmediate(() => {
    let out: { lines: string[]; code: number; stderr?: string };
    try {
      out = run();
    } catch (err) {
      out = { lines: [], code: 2, stderr: err instanceof Error ? err.message : String(err) };
    }
    for (const l of out.lines) {
      if (killed) break;
      stdout.write(`${l}\n`);
    }
    stdout.end();
    stderr.end(out.stderr ?? "");
    stdout.once("close", () => c.emit("close", killed ? null : out.code));
    stdout.resume();
  });
  return c;
}

/** Glob to RegExp: `**` any depth, `*` and `?` within one segment. */
function globRe(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") {
        i++;
        re += "(?:.*/)?";
      } else re += ".*";
    } else if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** Every path under `root` (the root itself followed if it is a link; links below it listed, not entered). */
function walk(root: string, skip: (name: string) => boolean = () => false): { path: string; dir: boolean }[] {
  const out: { path: string; dir: boolean }[] = [];
  const visit = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (skip(name)) continue;
      const p = join(dir, name);
      const st = lstatSync(p);
      const isDir = st.isDirectory();
      out.push({ path: p, dir: isDir });
      if (isDir) visit(p);
    }
  };
  if (statSync(root).isDirectory()) visit(root);
  else out.push({ path: root, dir: false });
  return out;
}

/** The flags, the value after each flag in `valued`, and the arguments after `--`. */
function split(args: string[], valued: string[]): { flags: Set<string>; values: Map<string, string[]>; rest: string[] } {
  const at = args.indexOf("--");
  const head = at < 0 ? args : args.slice(0, at);
  const rest = at < 0 ? [] : args.slice(at + 1);
  const flags = new Set<string>();
  const values = new Map<string, string[]>();
  for (let i = 0; i < head.length; i++) {
    const a = head[i]!;
    if (valued.includes(a)) values.set(a, [...(values.get(a) ?? []), head[++i] ?? ""]);
    else flags.add(a);
  }
  return { flags, values, rest };
}

/** rg --json [--ignore-case] [--fixed-strings] [--glob G] -- PATTERN PATH: one match record per line. */
function rg(args: string[]) {
  const { flags, values, rest } = split(args, ["--glob"]);
  const [pattern, path] = rest;
  if (pattern === undefined || path === undefined) return { lines: [], code: 2, stderr: "rg: usage" };
  if (!existsSync(path)) return { lines: [], code: 2, stderr: `rg: ${path}: No such file or directory` };
  const source = flags.has("--fixed-strings") ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern;
  const re = new RegExp(source, flags.has("--ignore-case") ? "i" : "");
  const globs = (values.get("--glob") ?? []).map((g) => ({ re: globRe(g), base: !g.includes("/") }));
  const lines: string[] = [];
  for (const e of walk(path)) {
    if (e.dir || lstatSync(e.path).isSymbolicLink()) continue;
    const rel = relative(path, e.path) || basename(e.path);
    if (globs.length && !globs.some((g) => g.re.test(g.base ? basename(rel) : rel))) continue;
    let text: string;
    try {
      text = readFileSync(e.path, "utf8");
    } catch {
      continue;
    }
    const ls = text.split("\n");
    if (ls.at(-1) === "") ls.pop();
    ls.forEach((line, i) => {
      if (re.test(line)) lines.push(JSON.stringify({ type: "match", data: { path: { text: e.path }, lines: { text: `${line}\n` }, line_number: i + 1 } }));
    });
  }
  return { lines, code: lines.length ? 0 : 1 };
}

/** fd --glob --absolute-path [--exclude X]... [--full-path] -- PATTERN PATH: one absolute path per line. */
function fd(args: string[]) {
  const { flags, values, rest } = split(args, ["--exclude"]);
  const [pattern, path] = rest;
  if (pattern === undefined || path === undefined) return { lines: [], code: 2, stderr: "fd: usage" };
  if (!existsSync(path)) return { lines: [], code: 1, stderr: `fd: '${path}' is not a directory` };
  const re = globRe(pattern);
  const excludes = (values.get("--exclude") ?? []).map(globRe);
  const lines: string[] = [];
  for (const e of walk(path, (name) => excludes.some((x) => x.test(name)))) {
    const subject = flags.has("--full-path") ? e.path : basename(e.path);
    if (re.test(subject)) lines.push(e.dir ? `${e.path}/` : e.path);
  }
  return { lines, code: 0 };
}
