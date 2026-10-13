import { existsSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { DefaultPackageManager } from "@earendil-works/pi-coding-agent";
import type { PiLoaderOptions } from "./extension-types";

/**
 * Sova's own extensions from a chat process's own code (§app.chat-processes/code-generations): a chat
 * process running from a code generation (`SOVA_CHAT_LIVE_ROOT` names the checkout it was copied from,
 * and is not where this file runs) loads every extension that lies in a Sova checkout's `pi-config/`,
 * the live one or another generation's, from the same place in its own copy. Bun keys modules by
 * their real path, so an extension loaded through the agent dir's link into the checkout would be a
 * second instance of every module the runtime itself imports from `pi-config/` (two trackers, two
 * worker hosts). Installed packages, a project's own extensions and a worktree's own agent dir stay
 * where they are, and so do skills, prompts and themes.
 *
 * Quirk P24 own-code-discovery (QUIRKS.md): pi's loader takes the extensions it discovers only from
 * its package manager's resolve(), so that is where the paths are rewritten, keeping pi's enabled
 * flags (/extensions toggles), metadata and trust. A worker's listed extensions never pass through
 * resolve(): ownCodeLoader maps them.
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

/** The mapping in force for this process, or null when it runs the checkout itself (the server, a live fallback). */
export function ownCodeOf(env: NodeJS.ProcessEnv = process.env, own = OWN_ROOT): OwnCode | null {
  const live = env.SOVA_CHAT_LIVE_ROOT?.trim();
  if (!live || real(live) === real(own)) return null;
  const codeRoot = env.SOVA_CHAT_CODE_ROOT?.trim();
  return { own: real(own), live: real(live), ...(codeRoot ? { codeRoot: real(codeRoot) } : {}) };
}

const under = (p: string, dir: string) => p === dir || p.startsWith(dir + sep);

/** `path` re-rooted in this process's own copy when it lies in a Sova checkout's `pi-config/`; else null. */
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

/** The copy's name for messages: its id under the code root, else its path. */
const idOf = (o: OwnCode) => (o.codeRoot && under(o.own, o.codeRoot) ? relative(o.codeRoot, o.own).split(sep)[0]! : o.own);

type Resolve = (this: unknown, ...args: never[]) => Promise<{ extensions: { path: string }[] }>;
interface ResolvesPaths {
  prototype: { resolve: Resolve };
}

/**
 * Rewrite the extension paths `cls`'s resolve() answers (pi's DefaultPackageManager, or a test's
 * copy of pi): each Sova one to its place in this copy; one this copy lacks (added to the checkout
 * since it was made) is left out until the chat reloads onto newer code, never loaded live. The call
 * puts resolve() back.
 */
export function patchResolve(cls: ResolvesPaths, o: OwnCode, log: (line: string) => void = (l) => console.warn(`[own-code] ${l}`)): () => void {
  const original = cls.prototype.resolve;
  const mapped: Resolve = async function (this: unknown, ...args) {
    const out = await original.apply(this, args);
    out.extensions = out.extensions.flatMap((r) => {
      const m = ownCode(r.path, o);
      if (m === null) return [r];
      if (existsSync(m)) return [{ ...r, path: m }];
      log(`${relative(o.own, m)} is not in this chat's code (${idOf(o)}): left out until the chat reloads onto newer code`);
      return [];
    });
    return out;
  };
  cls.prototype.resolve = mapped;
  return () => {
    if (cls.prototype.resolve === mapped) cls.prototype.resolve = original;
  };
}

let installed = false;
/** Once per process, and only in a chat process on a code generation: never in the server. */
export function installOwnCode(o: OwnCode | null = ownCodeOf()): void {
  if (installed || !o) return;
  installed = true;
  patchResolve(DefaultPackageManager as unknown as ResolvesPaths, o);
}

/**
 * A loader's listed extensions (a worker's, a hidden chat's) mapped the same way. One the copy lacks
 * fails the build: the parent listed it from older or newer code, and it is never mixed silently.
 */
export function ownCodeLoader(loader: PiLoaderOptions, o: OwnCode | null = ownCodeOf()): PiLoaderOptions {
  if (!o || !loader.additionalExtensionPaths?.length) return loader;
  const additionalExtensionPaths = loader.additionalExtensionPaths.map((p) => {
    if (/^[a-z]+:/.test(p)) return p; // npm:, git:, builtin: sources
    const m = ownCode(p, o);
    if (m === null) return p;
    if (!existsSync(m)) throw new Error(`${relative(o.own, m)} is not in this chat's code (${idOf(o)}); reload the parent chat`);
    return m;
  });
  return { ...loader, additionalExtensionPaths };
}
