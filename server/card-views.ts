import { existsSync, readFileSync, realpathSync, statSync, watch, type FSWatcher } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CARDS_DIR, VIEW_FILE } from "../shared/transcript-cards";

/**
 * How Sova builds a project's card view (§chat.transcript-cards/building) and redraws it on save
 * (§chat.transcript-cards/redraw). Sova's own fixed settings, always: Solid JSX through
 * babel-preset-solid, TypeScript stripped by esbuild, the toolkit (`sova:card`) and Solid itself
 * from Sova's own copies, relative imports inside the checkout and packages the checkout already
 * has installed, bundled as one plain script. Every import is resolved and every file read by
 * this module (esbuild sees only a namespace of its own, so it never looks for a tsconfig.json or
 * a package.json), Babel runs with `babelrc: false`, `configFile: false` and no browserslist, so
 * nothing of the project's build config, plugins, `package.json` scripts or install scripts is
 * read or run. What it builds runs only in the sealed box (src/lib/card-box.ts), never here.
 *
 * Each build watches the checkout files it read (never node_modules): a save rebuilds the view
 * and wakes every page waiting on its code (`viewCode` with the hash it has).
 */

const NS = "sova-view";
const SOVA_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOOLKIT_ENTRY = join(SOVA_ROOT, "src", "card-toolkit", "index.ts");
/** Solid comes from Sova, so the view's JSX, its signals and the toolkit's are one Solid. */
const SOVA_PACKAGES = new Set(["solid-js"]);
const CONDITIONS = ["browser", "import", "module", "default"];
const EXTENSIONS = [".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs", ".json", ".css"];
/** A built view is at most this large. */
export const VIEW_CODE_MAX = 4 * 1024 * 1024;
const BUILD_TIMEOUT_MS = 30_000;

export type ViewBuild = { ok: true; hash: string; code: string } | { ok: false; hash: string; error: string };

class Refused extends Error {}

const inside = (root: string, p: string) => p === root || p.startsWith(root + sep);
const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** A file by Node's rules: as is, with an extension, or a folder's index. */
function asFile(p: string): string | null {
  if (isFile(p)) return p;
  for (const e of EXTENSIONS) if (isFile(p + e)) return p + e;
  for (const e of EXTENSIONS) if (isFile(join(p, `index${e}`))) return join(p, `index${e}`);
  return null;
}

/** An `exports` target for the browser: the first condition, in the map's own order, that we take. */
function exportTarget(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    for (const x of v) {
      const t = exportTarget(x);
      if (t) return t;
    }
    return null;
  }
  if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (CONDITIONS.includes(k)) {
      const t = exportTarget(x);
      if (t) return t;
    }
  }
  return null;
}

/** A bare import (`pkg`, `@scope/pkg/sub`) from `fromDir`, found in node_modules up to `root`, never above it. */
function resolvePackage(spec: string, fromDir: string, root: string): string | null {
  const parts = spec.split("/");
  const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
  const sub = parts.slice(spec.startsWith("@") ? 2 : 1).join("/");
  for (let dir = fromDir; inside(root, dir); dir = dirname(dir)) {
    const pkgDir = join(dir, "node_modules", name);
    if (existsSync(pkgDir)) {
      let pkg: Record<string, unknown> = {};
      try {
        pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as Record<string, unknown>;
      } catch {
        pkg = {};
      }
      const exp = pkg.exports;
      if (exp !== undefined) {
        const map = typeof exp === "string" || Array.isArray(exp) || !Object.keys(exp as object).some((k) => k.startsWith(".")) ? { ".": exp } : (exp as Record<string, unknown>);
        const t = exportTarget(map[sub ? `./${sub}` : "."]);
        if (t) return asFile(join(pkgDir, t));
        return null;
      }
      if (sub) return asFile(join(pkgDir, sub));
      const browser = typeof pkg.browser === "string" ? pkg.browser : null;
      for (const f of [browser, pkg.module, pkg.main]) if (typeof f === "string") {
        const hit = asFile(join(pkgDir, f));
        if (hit) return hit;
      }
      return asFile(join(pkgDir, "index"));
    }
    if (dir === root) break;
  }
  return null;
}

type Esbuild = typeof import("esbuild");
let esbuildP: Promise<Esbuild> | null = null;
const esbuild = () => (esbuildP ??= import("esbuild"));

async function babelSolid(code: string, filename: string): Promise<string> {
  const babel = await import("@babel/core");
  const solid = (await import("babel-preset-solid")).default;
  const out = await babel.transformAsync(code, {
    filename,
    babelrc: false,
    configFile: false,
    browserslistConfigFile: false,
    cwd: SOVA_ROOT,
    root: SOVA_ROOT,
    sourceType: "module",
    presets: [[solid, { generate: "dom", hydratable: false }]],
    parserOpts: { plugins: ["jsx"] },
    sourceMaps: false,
    comments: false,
  });
  return out?.code ?? "";
}

/**
 * Build a card folder's `view.tsx`, read from `checkout`: the script (an IIFE) or the error, the
 * file and line when known, and every checkout file it read.
 */
export async function buildView(checkout: string, name: string): Promise<{ build: ViewBuild; inputs: string[] }> {
  const root = real(checkout);
  const entry = join(root, CARDS_DIR, name, VIEW_FILE);
  const inputs = new Set<string>([entry]);
  const rel = (p: string) => (inside(root, p) ? relative(root, p) : p);
  const fail = (error: string) => {
    const hash = createHash("sha256").update(`error\0${error}`).digest("hex").slice(0, 16);
    return { build: { ok: false as const, hash, error }, inputs: [...inputs] };
  };
  if (!isFile(entry)) return fail(`${CARDS_DIR}/${name}/${VIEW_FILE} is missing.`);
  const eb = await esbuild();
  const sovaRoot = real(SOVA_ROOT);
  try {
    const result = await Promise.race([
      eb.build({
        entryPoints: [`${NS}:${entry}`],
        bundle: true,
        write: false,
        format: "iife",
        platform: "browser",
        target: "es2022",
        charset: "utf8",
        legalComments: "none",
        logLevel: "silent",
        absWorkingDir: sovaRoot,
        tsconfigRaw: "{}",
        define: { "process.env.NODE_ENV": '"production"' },
        plugins: [
          {
            name: "sova-card-view",
            setup(build) {
              build.onResolve({ filter: /.*/ }, (args) => {
                if (args.kind === "entry-point") return { path: entry, namespace: NS };
                const spec = args.path;
                const fromDir = args.resolveDir || dirname(args.importer);
                if (spec === "sova:card") return { path: real(TOOLKIT_ENTRY), namespace: NS };
                if (/^[a-z]+:/i.test(spec)) throw new Refused(`"${spec}" can't be imported: a view imports only sova:card, files in its checkout and packages installed there.`);
                const fromSova = inside(sovaRoot, fromDir) && !inside(root, fromDir);
                if (spec.startsWith(".") || spec.startsWith("/")) {
                  const hit = asFile(resolve(fromDir, spec));
                  if (!hit) throw new Refused(`${rel(args.importer)} imports "${spec}", which isn't there.`);
                  const r = real(hit);
                  if (!inside(fromSova ? sovaRoot : root, r)) throw new Refused(`${rel(args.importer)} imports "${spec}", outside the checkout.`);
                  return { path: r, namespace: NS };
                }
                const pkgName = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
                const own = fromSova || SOVA_PACKAGES.has(pkgName);
                const hit = own ? resolvePackage(spec, fromSova ? fromDir : sovaRoot, sovaRoot) : resolvePackage(spec, fromDir, root);
                if (!hit) throw new Refused(`${rel(args.importer)} imports "${spec}", which isn't installed in the checkout.`);
                const r = real(hit);
                if (!inside(own ? sovaRoot : root, r)) throw new Refused(`"${spec}" resolves outside the checkout.`);
                return { path: r, namespace: NS };
              });
              build.onLoad({ filter: /.*/, namespace: NS }, async (args) => {
                const file = args.path;
                if (inside(root, file) && !file.includes(`${sep}node_modules${sep}`)) inputs.add(file);
                const text = readFileSync(file, "utf8");
                const ext = extname(file);
                const resolveDir = dirname(file);
                if (ext === ".json") return { contents: text, loader: "json", resolveDir };
                if (ext === ".css") return { contents: `const s=document.createElement("style");s.textContent=${JSON.stringify(text)};document.head.append(s);`, loader: "js", resolveDir };
                if (ext === ".ts" || ext === ".tsx" || ext === ".jsx") {
                  const stripped = await eb.transform(text, { loader: ext === ".ts" ? "ts" : ext === ".tsx" ? "tsx" : "jsx", jsx: "preserve", tsconfigRaw: "{}", sourcefile: rel(file), target: "es2022" });
                  const code = ext === ".ts" ? stripped.code : await babelSolid(stripped.code, file);
                  return { contents: code, loader: "js", resolveDir };
                }
                return { contents: text, loader: "js", resolveDir };
              });
            },
          },
        ],
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Refused(`The build took longer than ${BUILD_TIMEOUT_MS / 1000} s.`)), BUILD_TIMEOUT_MS).unref?.()),
    ]);
    // esbuild names each module's file in a comment: never a path of this machine's in the browser.
    const code = (result.outputFiles?.[0]?.text ?? "").replace(new RegExp(`^\\s*// ${NS}:.*\\n`, "gm"), "");
    if (code.length > VIEW_CODE_MAX) return fail(`The built view is over ${VIEW_CODE_MAX / 1024 / 1024} MB.`);
    const hash = createHash("sha256").update(code).digest("hex").slice(0, 16);
    return { build: { ok: true, hash, code }, inputs: [...inputs] };
  } catch (err) {
    return fail(buildErrorText(err, rel));
  }
}

/** A build's error in words: the first message, at its file and line when known. */
function buildErrorText(err: unknown, rel: (p: string) => string): string {
  const e = err as { errors?: { text: string; location?: { file: string; line: number; column: number } | null; detail?: unknown }[]; message?: string; loc?: { line: number; column: number } };
  const first = e.errors?.[0];
  if (first) {
    const inner = first.detail instanceof Error ? first.detail : null;
    if (inner) return buildErrorText(inner, rel);
    const loc = first.location;
    const file = loc ? rel(loc.file.replace(new RegExp(`^${NS}:`), "")) : null;
    return `${file ? `${file}:${loc!.line}:${loc!.column + 1}: ` : ""}${first.text}`;
  }
  if (err instanceof Refused) return err.message;
  const msg = (e.message ?? String(err)).replace(/^[^:]*?\/(\.sova\/cards\/)/, "$1");
  return msg.split("\n").slice(0, 8).join("\n");
}

// ---- the built views, watched (§chat.transcript-cards/redraw) ----------------------------------

interface Entry {
  build: ViewBuild | null;
  building: Promise<ViewBuild> | null;
  inputs: string[];
  watchers: FSWatcher[];
  waiters: Set<() => void>;
  timer: ReturnType<typeof setTimeout> | null;
  /** Whether a save came in during the build in flight. */
  dirty: boolean;
  usedAt: number;
}

const views = new Map<string, Entry>();
const DEBOUNCE_MS = 40;
/** A view no page asked for in this long stops being watched. */
const IDLE_MS = 10 * 60_000;

const keyOf = (checkout: string, name: string) => `${real(checkout)}\0${name}`;

function rewatch(e: Entry, onChange: () => void): void {
  for (const w of e.watchers) w.close();
  e.watchers = [];
  const dirs = new Map<string, Set<string>>();
  for (const f of e.inputs) {
    const d = dirname(f);
    if (!dirs.has(d)) dirs.set(d, new Set());
    dirs.get(d)!.add(f.slice(d.length + 1));
  }
  for (const [dir, names] of dirs) {
    try {
      const w = watch(dir, { persistent: false }, (_ev, file) => {
        if (!file || names.has(String(file))) onChange();
      });
      w.on("error", () => undefined);
      e.watchers.push(w);
    } catch {
      // a folder that went away: the next request rebuilds
    }
  }
}

function startBuild(key: string, checkout: string, name: string, e: Entry): Promise<ViewBuild> {
  e.dirty = false;
  const p = buildView(checkout, name).then(({ build, inputs }) => {
    const changed = e.build?.hash !== build.hash;
    e.build = build;
    e.inputs = inputs;
    e.building = null;
    rewatch(e, () => scheduleRebuild(key, checkout, name));
    if (e.dirty) scheduleRebuild(key, checkout, name);
    if (changed) wake(e);
    return build;
  });
  e.building = p;
  return p;
}

function scheduleRebuild(key: string, checkout: string, name: string): void {
  const e = views.get(key);
  if (!e) return;
  if (e.building) {
    e.dirty = true;
    return;
  }
  if (e.timer) clearTimeout(e.timer);
  e.timer = setTimeout(() => {
    e.timer = null;
    if (Date.now() - e.usedAt > IDLE_MS) return drop(key);
    void startBuild(key, checkout, name, e);
  }, DEBOUNCE_MS);
}

function wake(e: Entry): void {
  const ws = [...e.waiters];
  e.waiters.clear();
  for (const w of ws) w();
}

function drop(key: string): void {
  const e = views.get(key);
  if (!e) return;
  for (const w of e.watchers) w.close();
  if (e.timer) clearTimeout(e.timer);
  wake(e);
  views.delete(key);
}

/**
 * A card folder's built view, as the page asks for it: at once when the build it has (`have`) is
 * not the current one, else once a save changes it, or after `waitMs` with the same build.
 */
export async function viewCode(checkout: string, name: string, have?: string | null, waitMs = 0, signal?: AbortSignal): Promise<ViewBuild> {
  const key = keyOf(checkout, name);
  let e = views.get(key);
  if (!e) {
    e = { build: null, building: null, inputs: [], watchers: [], waiters: new Set(), timer: null, dirty: false, usedAt: Date.now() };
    views.set(key, e);
  }
  e.usedAt = Date.now();
  const current = e.build ?? (await (e.building ?? startBuild(key, checkout, name, e)));
  if (!have || have !== current.hash || waitMs <= 0) return current;
  const entry = e;
  await new Promise<void>((done) => {
    const t = setTimeout(finish, waitMs);
    function finish() {
      clearTimeout(t);
      entry.waiters.delete(finish);
      signal?.removeEventListener("abort", finish);
      done();
    }
    entry.waiters.add(finish);
    signal?.addEventListener("abort", finish, { once: true });
  });
  return entry.building ? await entry.building : (entry.build ?? current);
}

/** Tests: stop watching every view. */
export function resetCardViewsForTest(): void {
  for (const k of [...views.keys()]) drop(k);
}
