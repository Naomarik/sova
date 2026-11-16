import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { DefaultPackageManager } from "@earendil-works/pi-coding-agent";
import type { PiLoaderOptions } from "./extension-types";

/**
 * Sova's own extensions from the process's own code (§app.chat-processes/code-generations): every
 * extension Sova ships (a name in this copy's `pi-config/extensions/`) loads from this copy, whatever
 * the agent dir links to: a link into any Sova tree (the checkout, a code generation, an older install
 * or developer copy) is re-rooted in this copy, and one the agent dir lacks altogether is added
 * (ownExtensions). Bun keys modules by their real path, so an extension loaded through the agent dir's
 * link into another tree would also be a second instance of every module the runtime itself imports
 * from `pi-config/` (two trackers, two worker hosts). A chat process running from a code generation
 * (`SOVA_CHAT_LIVE_ROOT` names the checkout it was copied from, `SOVA_CHAT_COPIES_ROOT` where the copies
 * live; both set by the launch for that process only, and deleted from a server's env at its boot)
 * maps the checkout's and the other generations' whole `pi-config/` (ownCode). Installed packages, a
 * project's own extensions and extensions Sova doesn't ship stay where they are, and so do skills,
 * prompts and themes. A process on another agent dir than its server's (a worker on its worktree's
 * `.agent`, useWorktreeConfig) keeps that tree's own extensions: only the generation mapping applies.
 *
 * Sova's mode engine (modes-entry.ts) runs every discovering chat's modes: it takes any discovered mode
 * extension's slot (isModeSlot), always on, and is added when there is none.
 *
 * Quirk P24 own-code-discovery (QUIRKS.md): pi's loader takes the extensions it discovers only from
 * its package manager's resolve(), so that is where the paths are rewritten, keeping pi's enabled
 * flags (/extensions toggles), metadata and trust. A worker's listed extensions never pass through
 * resolve(): ownCodeLoader and workerModePaths map them.
 */

/** Where this process's code lives (the generation's root, or the checkout itself). */
const OWN_ROOT = resolve(import.meta.dirname, "..", "..", "..");

export interface OwnCode {
  /** This process's code root. */
  own: string;
  /** The checkout the generations are copied from. */
  live: string;
  /** Where the generations live (any `<root>/<id>/pi-config/` maps too). */
  codeRoot?: string;
}

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/** The generation mapping in force for this process, or null when it runs the checkout itself (the server, a live fallback). */
export function ownCodeOf(env: NodeJS.ProcessEnv = process.env, own = OWN_ROOT): OwnCode | null {
  const live = env.SOVA_CHAT_LIVE_ROOT?.trim();
  if (!live || real(live) === real(own)) return null;
  const codeRoot = env.SOVA_CHAT_COPIES_ROOT?.trim();
  return { own: real(own), live: real(live), ...(codeRoot ? { codeRoot: real(codeRoot) } : {}) };
}

const under = (p: string, dir: string) => p === dir || p.startsWith(dir + sep);

/** `path` re-rooted in this process's own copy when it lies in the checkout's or a generation's `pi-config/`; else null. */
export function ownCode(path: string, o: OwnCode): string | null {
  const p = real(path);
  const from = (root: string) => {
    const pc = join(root, "pi-config");
    return under(p, pc) ? join(o.own, "pi-config", relative(pc, p)) : null;
  };
  if (under(p, join(o.own, "pi-config"))) return p;
  const hit = from(o.live);
  if (hit) return hit;
  if (o.codeRoot && under(p, o.codeRoot)) {
    const id = relative(o.codeRoot, p).split(sep)[0];
    if (id) return from(join(o.codeRoot, id));
  }
  return null;
}

const sovaTrees = new Map<string, boolean>();
/** Whether `root` is a Sova tree (an install, a checkout, a generation): its package.json is named `sova`
    and it has `pi-config/install.sh`. */
export function isSovaTree(root: string): boolean {
  let known = sovaTrees.get(root);
  if (known === undefined) {
    try {
      known = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))?.name === "sova" && existsSync(join(root, "pi-config", "install.sh"));
    } catch {
      known = false;
    }
    sovaTrees.set(root, known);
  }
  return known;
}

const EXTENSIONS_SEG = `${sep}pi-config${sep}extensions${sep}`;

/** Where `path` lies among some Sova tree's shipped extensions (through any link): the extension's name
    (its directory or loose file under `pi-config/extensions/`) and the path inside it; else null. */
export function sovaExtensionOf(path: string): { root: string; name: string; rel: string } | null {
  const p = real(path);
  const at = p.lastIndexOf(EXTENSIONS_SEG);
  if (at < 0) return null;
  const root = p.slice(0, at);
  const rel = p.slice(at + EXTENSIONS_SEG.length);
  const name = rel.split(sep)[0];
  return name && isSovaTree(root) ? { root, name, rel } : null;
}

/** `path` in this copy (`own`) when it is one of any Sova tree's shipped extensions (or a file in one);
    else null. The result may not exist: a name this copy doesn't ship. */
export function shippedOwn(path: string, own: string = OWN_ROOT): string | null {
  const hit = sovaExtensionOf(path);
  return hit ? join(real(own), "pi-config", "extensions", hit.rel) : null;
}

/** pi's own rule for a directory's extension entries (package-manager.js resolveExtensionEntries): its
    package.json `pi.extensions` that exist, else index.ts, else index.js; null when none. */
function extensionEntries(dir: string): string[] | null {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))?.pi?.extensions;
    if (Array.isArray(manifest)) {
      const found = manifest.filter((e): e is string => typeof e === "string").map((e) => resolve(dir, e)).filter((e) => existsSync(e));
      if (found.length) return found;
    }
  } catch {
    // No manifest: the index files.
  }
  for (const index of ["index.ts", "index.js"]) if (existsSync(join(dir, index))) return [join(dir, index)];
  return null;
}

/** The extensions this copy ships, as pi would discover them from a link to each, by name and in name
    order: each directory of `<own>/pi-config/extensions/` that is an extension, and each loose .ts/.js
    file. The mode folder is not among them: the engine has its own rule. */
export function shippedExtensions(own: string = OWN_ROOT): { name: string; paths: string[] }[] {
  const dir = join(real(own), "pi-config", "extensions");
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    if (name.startsWith(".") || name === "node_modules" || name === MODE_DIR) return [];
    const path = join(dir, name);
    let isDir: boolean;
    try {
      isDir = statSync(path).isDirectory();
    } catch {
      return [];
    }
    if (!isDir) return /\.[jt]s$/.test(name) && !/\.test\.[jt]s$/.test(name) ? [{ name, paths: [path] }] : [];
    const paths = extensionEntries(path);
    return paths ? [{ name, paths }] : [];
  });
}

/** The pi-config folder whose name makes an extension the mode slot. */
const MODE_DIR = "mode";
/** The loose extension a copied-sessions hermetic agent dir never runs (scripts/hermetic-agent-dir.mjs). */
const WAKE_NUDGE = "wake-nudge.ts";
/** scripts/hermetic-agent-dir.mjs's mark of an agent dir holding copies of real sessions: wake-nudge stays off. */
export const COPIED_SESSIONS_MARKER = "copied-sessions.json";

/**
 * Whether `path` is a mode slot: a folder named `mode` directly in an `extensions` folder (an agent dir's,
 * a pi-config's), or a file of its index, by its own name or through any link. Its contents don't count:
 * the slot is the folder, so recognising it never depends on what the pi mode extension ships.
 */
export function isModeSlot(path: string): boolean {
  return [resolve(path), real(path)].some((p) => {
    const dir = /^index\.[cm]?[jt]s$/.test(basename(p)) ? dirname(p) : p;
    return basename(dir) === MODE_DIR && basename(dirname(dir)) === "extensions";
  });
}

/** Sova's modules that take the place of the mode extension's files in a worker's list. */
export interface ModesEntries {
  /** For the extension itself (its directory or index.ts). */
  entry: string;
  /** For mode/spec-worker.ts. */
  specWorker: string;
  /** For mode/project-tools-worker.ts: a slot name, no file (see PROJECT_TOOLS_WORKER_EXTENSION in subagents/index.ts). */
  projectToolsWorker: string;
}

/** This copy's mode entry modules (server/harness/pi/modes-*.ts), the paths that take the mode slots. */
export function modesEntries(own = OWN_ROOT): ModesEntries {
  const dir = join(own, "server", "harness", "pi");
  return { entry: join(dir, "modes-entry.ts"), specWorker: join(dir, "modes-spec-worker.ts"), projectToolsWorker: join(dir, "modes-project-tools-worker.ts") };
}

/**
 * Which of the mode extension's files a listed path is, through any link, or null. By name only, never by
 * existence: `project-tools-worker.ts` is a slot name the subagents extension lists
 * (PROJECT_TOOLS_WORKER_EXTENSION in pi-config/extensions/subagents/index.ts), not a file path.
 */
export function modeFileOf(path: string): keyof ModesEntries | null {
  if (isModeSlot(path)) return "entry";
  for (const p of [resolve(path), real(path)]) {
    const dir = dirname(p);
    if (basename(dir) !== MODE_DIR || basename(dirname(dir)) !== "extensions") continue;
    if (basename(p) === "spec-worker.ts") return "specWorker";
    if (basename(p) === "project-tools-worker.ts") return "projectToolsWorker";
  }
  return null;
}

/**
 * A worker's listed extensions with the mode files in Sova's hands, each in its own slot (never dropped
 * and appended: load order is hook and tool order): whichever tree a mode file lies in (a worktree's
 * `.agent/extensions/mode` included), Sova's module takes its place, so no tree's copy loads beside
 * Sova's engine.
 */
export function workerModePaths(paths: readonly string[], entries: ModesEntries = modesEntries()): string[] {
  return paths.map((p) => {
    if (/^[a-z]+:/.test(p)) return p;
    const kind = modeFileOf(p);
    return kind === null ? p : entries[kind];
  });
}

/** Whether this process runs on its server's own agent dir (`agentDir`): not a worker on its worktree's
    `.agent` (useWorktreeConfig), whose `SOVA_CHAT_STATE_ROOT` names another agent dir's state. */
export function onOwnAgentDir(agentDir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const state = env.SOVA_CHAT_STATE_ROOT?.trim();
  return !state || real(dirname(state)) === real(agentDir);
}

/** Where the mode engine finds the trusted spec tools when SOVA_SPEC_CORE is unset (the server, its in-process
    and hidden chats): on the server's own agent dir this copy's (`own`), as for its shipped extensions, never
    through the agent dir's link (it may lead into another, older copy); on another agent dir (a worker on its
    worktree's `.agent`) that tree's own. A hermetic branch server's own copy is the branch: its own tools. */
export function ownSpecCore(agentDir: string, env: NodeJS.ProcessEnv = process.env, own: string = OWN_ROOT): string {
  return onOwnAgentDir(agentDir, env) ? join(real(own), "pi-config", "extensions", "spec", "core") : join(agentDir, "extensions", "spec", "core");
}

/** The process's agent dir as pi reads it (PI_CODING_AGENT_DIR, else ~/.pi/agent). */
function agentDirOf(env: NodeJS.ProcessEnv): string {
  const dir = env.PI_CODING_AGENT_DIR?.trim();
  if (!dir) return join(homedir(), ".pi", "agent");
  return dir === "~" ? homedir() : dir.startsWith("~/") ? join(homedir(), dir.slice(2)) : resolve(dir);
}

/** The test knob `SOVA_TEST_OWN_EXTENSIONS=linked`, set only by the test runner (scripts/test-env.mjs testEnv)
    for every test, whose throwaway agent dirs link nothing: the shipped extensions an agent dir lacks are not
    added. It never touches the remapping or the mode engine. */
export const TEST_OWN_EXTENSIONS_ENV = "SOVA_TEST_OWN_EXTENSIONS";
const addsMissing = (env: NodeJS.ProcessEnv) => env[TEST_OWN_EXTENSIONS_ENV]?.trim() !== "linked";

type Resolved = { path: string; enabled: boolean; metadata: { source?: string; scope?: string; origin?: string; baseDir?: string } };
type Resolve = (this: unknown, ...args: never[]) => Promise<{ extensions: Resolved[] }>;
interface ResolvesPaths {
  prototype: { resolve: Resolve };
}

/** What a package manager tells about itself (pi's DefaultPackageManager; a test's fake may have none). */
interface PmFacts {
  agentDir?: string;
  settingsManager?: { getGlobalSettings(): { extensions?: unknown } };
}

/** A settings pattern (pi's subset: `*`, `**`, `?`) as a whole-path regular expression. */
function globRe(glob: string): RegExp {
  const src = glob
    .replace(/^\.\//, "")
    .split("/")
    .map((seg) => (seg === "**" ? "\u0000" : seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")))
    .join("/")
    .replace(/\u0000\//g, "(?:[^/]+/)*")
    .replace(/\/\u0000/g, "(?:/[^/]+)*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${src}$`);
}

/** Whether `name` (a shipped extension the agent dir doesn't have) stays off by the user's /extensions
    patterns (the agent dir's settings.json `extensions`), matched as if it were linked there, by pi's
    override rule (package-manager.js isEnabledByOverrides): `!glob` off, `+path` on, `-path` off. */
function offByName(name: string, isFile: boolean, pm: PmFacts): boolean {
  let patterns: unknown;
  try {
    patterns = pm.settingsManager?.getGlobalSettings().extensions;
  } catch {
    return false;
  }
  if (!Array.isArray(patterns)) return false;
  const rels = isFile ? [`extensions/${name}`] : [`extensions/${name}/index.ts`, `extensions/${name}`];
  const hits = (kind: string, exact: boolean) =>
    patterns.some((p) => typeof p === "string" && p.startsWith(kind) && rels.some((rel) => (exact ? p.slice(1).replace(/^\.\//, "") === rel : globRe(p.slice(1)).test(rel))));
  let on = !hits("!", false);
  if (hits("+", true)) on = true;
  if (hits("-", true)) on = false;
  return !on;
}

/** The process's own log for these lines. */
const warn = (l: string) => console.warn(`[own-code] ${l}`);
/** The left-out lines each log has had (by extension and path): every resolve() of the process (its services
    build, each reload) would repeat them, and installOwnCode's log is the process's one. */
const leftOutLogged = new WeakMap<(line: string) => void, Set<string>>();

export interface OwnExtensionsOptions {
  /** This process's code root (its own copy). */
  own?: string;
  /** The mode engine's module (modes-entry.ts of `own`). */
  entry?: string;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

/**
 * One resolve()'s extensions as Sova loads them (`pm`: the package manager that answered):
 * - the mode slot: the first discovered one is Sova's engine, always on (/extensions can't turn modes off;
 *   the mode menu does); any other is dropped; with none, the engine is added;
 * - on the server's own agent dir: each one in a Sova tree's `pi-config/extensions/` is this copy's, in its
 *   slot, with pi's enabled flag (an /extensions "off" stays off); one this copy doesn't ship is left out;
 *   each shipped one the agent dir doesn't name is added, unless the user's patterns turn it off by name;
 * - on another agent dir (a worktree's `.agent`): only the generation mapping (`o`);
 * - an agent dir holding copied sessions (COPIED_SESSIONS_MARKER) never runs wake-nudge.
 * What is added goes among the agent dir's own extensions by name, where a link to it would be found.
 */
export function ownExtensions(extensions: readonly Resolved[], pm: PmFacts, o: OwnCode | null, opts: OwnExtensionsOptions = {}): Resolved[] {
  const own = real(opts.own ?? o?.own ?? OWN_ROOT);
  const entry = opts.entry ?? modesEntries(own).entry;
  const env = opts.env ?? process.env;
  const log = opts.log ?? warn;
  const agentDir = pm.agentDir ?? agentDirOf(env);
  const ownDir = onOwnAgentDir(agentDir, env);
  const copied = existsSync(join(agentDir, COPIED_SESSIONS_MARKER));
  const userExtensions = join(resolve(agentDir), "extensions");
  /** The agent dir's name for a discovered path (`<agent dir>/extensions/<name>/…`), else null. */
  const nameIn = (path: string) => (under(resolve(path), userExtensions) ? relative(userExtensions, resolve(path)).split(sep)[0] || null : null);
  /** The name an auto-discovered extension goes by in its folder (the agent dir's, a project's `.pi/extensions/`). */
  const autoName = (r: Resolved) => {
    if (r.metadata?.source !== "auto") return null;
    const p = resolve(r.path);
    const at = p.lastIndexOf(`${sep}extensions${sep}`);
    return at < 0 ? null : p.slice(at + `${sep}extensions${sep}`.length).split(sep)[0] || null;
  };
  const named = new Set<string>();
  const seen = new Set<string>();
  let mode = false;
  const out: (Resolved & { name?: string })[] = [];
  for (const r of extensions) {
    const name = nameIn(r.path);
    const folderName = autoName(r);
    if (name) named.add(name);
    if (folderName) named.add(folderName);
    if (isModeSlot(r.path)) {
      if (!mode) out.push({ ...r, path: entry, enabled: true, ...(name ? { name } : {}) });
      mode = true;
      continue;
    }
    const shipped = ownDir ? sovaExtensionOf(r.path) : null;
    if (shipped) named.add(shipped.name);
    if (copied && (name === WAKE_NUDGE || shipped?.name === WAKE_NUDGE)) continue;
    const mapped = shipped ? join(own, "pi-config", "extensions", shipped.rel) : o ? ownCode(r.path, o) : null;
    if (mapped === null) {
      out.push(name ? { ...r, name } : r);
      continue;
    }
    if (!existsSync(mapped)) {
      if (shipped && !(o && ownCode(r.path, o))) {
        const key = `${shipped.name}\0${r.path}`;
        const logged = leftOutLogged.get(log) ?? new Set<string>();
        leftOutLogged.set(log, logged);
        if (!logged.has(key)) {
          logged.add(key);
          log(`the ${shipped.name} extension of another Sova copy (${shipped.root}) is not one this copy ships (${own}): left out (${r.path})`);
        }
      } else log(`${relative(own, mapped)} is not in this chat's code (${o ? idOf(o) : own}): left out until the chat reloads onto newer code`);
      continue;
    }
    if (seen.has(mapped)) continue;
    seen.add(mapped);
    out.push({ ...r, path: mapped, ...(name ? { name } : {}) });
  }
  const added: (Resolved & { name: string })[] = [];
  const meta = { source: "auto", scope: "user", origin: "top-level", baseDir: resolve(agentDir) };
  if (!mode) added.push({ path: entry, enabled: true, metadata: meta, name: MODE_DIR });
  if (ownDir && addsMissing(env)) {
    for (const s of shippedExtensions(own)) {
      if (named.has(s.name) || (copied && s.name === WAKE_NUDGE)) continue;
      const enabled = !offByName(s.name, s.paths.length === 1 && s.paths[0] === join(own, "pi-config", "extensions", s.name), pm);
      for (const path of s.paths) if (!seen.has(path)) added.push({ path, enabled, metadata: meta, name: s.name });
    }
  }
  for (const a of added) {
    const block = out.flatMap((r, i) => (r.metadata?.source === "auto" && r.metadata?.scope === "user" ? [i] : []));
    const before = block.find((i) => (out[i]!.name ?? "") > a.name);
    out.splice(before ?? (block.length ? block.at(-1)! + 1 : out.length), 0, a);
  }
  return out.map(({ name: _name, ...r }) => r as Resolved);
}

/** The copy's name for messages: its id under the code root, else its path. */
const idOf = (o: OwnCode) => (o.codeRoot && under(o.own, o.codeRoot) ? relative(o.codeRoot, o.own).split(sep)[0]! : o.own);

/**
 * Rewrite the extensions `cls`'s resolve() answers (pi's DefaultPackageManager, or a test's copy of pi)
 * by ownExtensions: Sova's engine in the mode slot (in the extension's own place, so tool and
 * prompt-section order stay as they were), every shipped extension from this copy. A loader that
 * discovers nothing (noExtensions) ignores resolve()'s extensions, so nothing is added there. The call
 * puts resolve() back.
 */
export function patchResolve(cls: ResolvesPaths, o: OwnCode | null, log: (line: string) => void = warn, opts: Omit<OwnExtensionsOptions, "log"> = {}): () => void {
  const original = cls.prototype.resolve;
  const mapped: Resolve = async function (this: unknown, ...args) {
    const out = await original.apply(this, args);
    out.extensions = ownExtensions(out.extensions, (this ?? {}) as PmFacts, o, { ...opts, log });
    return out;
  };
  cls.prototype.resolve = mapped;
  return () => {
    if (cls.prototype.resolve === mapped) cls.prototype.resolve = original;
  };
}

/**
 * The packages Sova's extensions import by name (§app.chat-processes/extension-loading). Quirk P26
 * native-extension-load: under Bun pi's loader imports an extension natively first and translates it
 * (jiti, a private copy of every file it imports) only when that fails, so each of these must resolve
 * from the extensions to the very copy pi runs. Sova's package.json names each at pi's own version.
 */
export const EXTENSION_DEPS = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "@earendil-works/pi-tui", "typebox"] as const;

/** `name`'s package directory (real path) as Node resolves it from inside `from`: each ancestor's node_modules, nearest first; null when none has it. */
export function packageFrom(from: string, name: string): string | null {
  for (let d = real(from); ; d = dirname(d)) {
    const c = join(d, "node_modules", name);
    if (!d.endsWith(`${sep}node_modules`) && existsSync(join(c, "package.json"))) return realpathSync(c);
    if (dirname(d) === d) return null;
  }
}

export interface DepDrift {
  name: string;
  /** What the extensions get (real path), or null when they can't resolve it. */
  extensions: string | null;
  /** pi's own copy (real path). */
  pi: string | null;
}

/** Each of EXTENSION_DEPS that the extensions under `extensionsDir` resolve to another copy than pi's own
    (pi-coding-agent itself: the one this code resolves; the rest: as pi resolves them from its real path). */
export function extensionDepDrift(extensionsDir: string, codeDir: string = import.meta.dirname): DepDrift[] {
  const piDir = packageFrom(codeDir, EXTENSION_DEPS[0]);
  return EXTENSION_DEPS.flatMap((name, i) => {
    const pi = i === 0 ? piDir : piDir && packageFrom(piDir, name);
    const extensions = packageFrom(extensionsDir, name);
    return extensions !== null && extensions === pi ? [] : [{ name, extensions, pi }];
  });
}

let installed = false;
/** Once per process, in every process (the server's warm-up as much as a chat's): resolve()'s rewrite
    (ownExtensions); a chat process on a code generation also maps the checkout's and the other
    generations' trees. Called at a services build, never at import: a server deletes the chat-process
    variables it inherited (from a chat's own tools) at boot, after its imports ran. Logs each package the
    copy's extensions would get from another copy than pi's (they still load, through pi's slow fallback). */
export function installOwnCode(o: OwnCode | null = ownCodeOf(), log: (line: string) => void = warn): void {
  if (installed) return;
  installed = true;
  patchResolve(DefaultPackageManager as unknown as ResolvesPaths, o, log);
  if (!o) return;
  for (const d of extensionDepDrift(join(o.own, "pi-config", "extensions")))
    log(`extensions get ${d.name} from ${d.extensions ?? "nowhere"}, pi from ${d.pi ?? "nowhere"}: they load through pi's slow fallback`);
}

/**
 * A loader's listed extensions (a worker's, a hidden chat's) mapped the same way: on the server's own
 * agent dir, a shipped extension of any Sova tree is this copy's; on a generation, the checkout's and
 * other generations' `pi-config/` too. One the copy lacks fails the build: the parent listed it from
 * older or newer code, and it is never mixed silently.
 */
export function ownCodeLoader(loader: PiLoaderOptions, o: OwnCode | null = ownCodeOf(), opts: { own?: string; env?: NodeJS.ProcessEnv } = {}): PiLoaderOptions {
  if (!loader.additionalExtensionPaths?.length) return loader;
  const env = opts.env ?? process.env;
  const ownDir = onOwnAgentDir(agentDirOf(env), env);
  if (!o && !ownDir) return loader;
  const own = real(opts.own ?? o?.own ?? OWN_ROOT);
  let changed = false;
  const additionalExtensionPaths = loader.additionalExtensionPaths.map((p) => {
    if (/^[a-z]+:/.test(p)) return p; // npm:, git:, builtin: sources
    const m = (ownDir ? shippedOwn(p, own) : null) ?? (o ? ownCode(p, o) : null);
    if (m === null) return p;
    if (!existsSync(m)) throw new Error(`${relative(own, m)} is not in this chat's code (${o ? idOf(o) : own}); reload the parent chat`);
    if (m !== p) changed = true;
    return m;
  });
  return changed ? { ...loader, additionalExtensionPaths } : loader;
}
