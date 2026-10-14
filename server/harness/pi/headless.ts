// A chat process without pi's terminal drawing code (§app.chat-processes/no-terminal-drawing, quirk P27
// headless-standins). A chat never draws the terminal's way: Sova's UI context ignores an extension's
// screens, widgets and footers (ui-bridge.ts), and nothing in Sova calls a tool's or a message's terminal
// renderer. Yet pi's entry, its core and the extensions load that code: pi-tui's screen and components,
// marked, pi's own terminal mode and components, and its syntax highlighter (highlight.js). In a chat
// process each of those modules is a stand-in with the same export names, built from the real module's
// export list, whose every export is inert: it can be called, constructed, extended and read, and does
// nothing. pi-tui's text, key, colour and terminal-image helpers and pi's theme stay real: extensions use
// them for status text. Installed by the chat process's entry before it imports pi; never in the server,
// the terminal pi or a test that doesn't ask for it.
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** pi-tui's modules a chat gets as stand-ins: everything but utils, keys, keybindings, fuzzy, colors,
    oklab, terminal-colors, terminal-image, the tiny lazy native-platform helpers (pi's clipboard reads
    them) and its index, which re-exports both kinds. */
const TUI_DRAWING = [
  String.raw`components/[^/]+`,
  "tui",
  "tui-alt-screen",
  "tui-main-screen",
  "tui-renderer",
  "terminal",
  "autocomplete",
  "editor-component",
  "alt-screen-search",
  "latex",
  "stdin-buffer",
  "kill-ring",
  "layout",
  "layout-node",
  "undo-stack",
  "wheel-scroll",
  "word-navigation",
];

/** Every module the stand-ins replace, by its real path. */
export const STANDIN_FILTER = new RegExp(
  [
    String.raw`/@earendil-works/pi-tui/dist/(?:${TUI_DRAWING.join("|")})\.js$`,
    String.raw`/marked/lib/marked\.esm\.js$`,
    // pi's terminal mode and its components; its theme (theme/) stays.
    String.raw`/@earendil-works/pi-coding-agent/dist/modes/interactive/(?:components/)?[^/]+\.js$`,
    String.raw`/@earendil-works/pi-coding-agent/dist/utils/syntax-highlight\.js$`,
  ].join("|"),
);

/** The two Bun APIs used here (Sova's tsconfig has no Bun types; chat processes run on Bun only). */
interface BunApi {
  Transpiler: new (o: { loader: "js" }) => { scan(code: string): { exports: string[] } };
  plugin(p: { name: string; setup(build: { onLoad(o: { filter: RegExp }, load: (a: { path: string }) => { contents: string; loader: "js" }): void }): void }): void;
}
const bun = (): BunApi => (globalThis as unknown as { Bun: BunApi }).Bun;

const KEY = Symbol.for("sova.chat.standin");
/** Distinct stand-in calls kept (a bound on the record, not on the stand-ins). */
const MAX_CALLS = 2000;

interface StandIns {
  make(module: string, name: string): unknown;
  calls: Map<string, number>;
}

/** Each stand-in call seen in this process (`new Text`, `Text#render()`, `keyHint()`, …) and how often. */
export function standInCalls(): ReadonlyMap<string, number> {
  return (globalThis as unknown as Record<symbol, StandIns | undefined>)[KEY]?.calls ?? new Map();
}

function standIns(log: string | undefined): StandIns {
  const calls = new Map<string, number>();
  let warned = false;
  const note = (what: string) => {
    const n = calls.get(what);
    // Constructing is what loading pi and the extensions does; anything else means drawing code ran.
    if (!warned && !what.startsWith("new ")) {
      warned = true;
      console.warn(`[headless] pi's terminal drawing code was called in this chat: ${what} (a stand-in answered, doing nothing; QUIRKS.md P27)`);
    }
    if (n === undefined && calls.size >= MAX_CALLS) return;
    calls.set(what, (n ?? 0) + 1);
    if (n === undefined && log) appendFileSync(log, `call ${what}\n`);
  };
  /** An inert object's members: each a callable stand-in named after it. */
  const members = (label: string): object =>
    new Proxy(Object.create(null), {
      get: (t, key) => (typeof key === "symbol" ? quiet(key) : key === "then" || key === "toJSON" ? undefined : key in t ? t[key] : inert(`${label}${key}`)),
    });
  const quiet = (key: symbol) => (key === Symbol.toPrimitive ? () => "" : key === Symbol.iterator ? function* () {} : undefined);
  /** A stand-in export: called, it returns another; constructed (or extended), its instances' members are stand-ins too. */
  function inert(label: string): unknown {
    let proto: object | undefined;
    const target = function () {};
    return new Proxy(target, {
      get(t, key) {
        if (key === "prototype") return (proto ??= members(`${label}#`));
        if (typeof key === "symbol") return quiet(key);
        if (key === "then" || key === "toJSON") return undefined;
        if (key === "name") return label;
        if (key === "length") return 0;
        return inert(`${label}.${key}`);
      },
      apply() {
        note(`${label}()`);
        return inert(`${label}()`);
      },
      construct(t, _args, newTarget) {
        note(`new ${label}`);
        return Reflect.construct(t, [], newTarget) as object;
      },
      set: () => true,
      defineProperty: () => true,
      deleteProperty: () => true,
    });
  }
  return { make: (_module, name) => inert(name), calls };
}

/** The stand-in module for the real module at `path`: the same export names, each a stand-in. */
export function standInSource(path: string, code = readFileSync(path, "utf8")): string {
  const { exports } = new (bun().Transpiler)({ loader: "js" }).scan(code);
  const at = JSON.stringify(path);
  const lines = [`const make = globalThis[Symbol.for("sova.chat.standin")].make;`];
  for (const name of exports) {
    if (name === "default") lines.push(`export default make(${at}, "default");`);
    else lines.push(`export const ${name} = make(${at}, ${JSON.stringify(name)});`);
  }
  // `export * from` names no names: re-export the target, itself a stand-in when the filter matches it.
  for (const m of code.matchAll(/^export \* from ["']([^"']+)["'];?$/gm)) lines.push(`export * from ${JSON.stringify(resolve(dirname(path), m[1]!))};`);
  return `${lines.join("\n")}\n`;
}

type Register = (filter: RegExp, load: (path: string) => string) => void;
/** Bun's own: a runtime plugin whose onLoad answers every module the filter matches. */
const bunPlugin: Register = (filter, load) =>
  bun().plugin({ name: "sova-chat-headless", setup: (build) => build.onLoad({ filter }, ({ path }) => ({ contents: load(path), loader: "js" })) });

let installed = false;
/**
 * Swap pi's terminal drawing code for stand-ins in this process, before anything imports pi. Chat
 * processes only (server/chat-runtime/main.ts). `SOVA_STANDIN_LOG=<file>` (tests) appends a line for
 * each module replaced (`load <path>`) and each new kind of stand-in call, as they happen.
 */
export function installHeadless(env: NodeJS.ProcessEnv = process.env, register: Register = bunPlugin): void {
  if (installed) return;
  installed = true;
  const log = env.SOVA_STANDIN_LOG?.trim() || undefined;
  (globalThis as unknown as Record<symbol, StandIns>)[KEY] = standIns(log);
  register(STANDIN_FILTER, (path) => {
    if (log) appendFileSync(log, `load ${path}\n`);
    return standInSource(path);
  });
}
