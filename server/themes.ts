import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stateRoot } from "./state-root";
import type { ThemeInfo, ThemeList, ThemeTokens } from "../shared/protocol";
import { DEFAULT_THEME_ID, parseTheme, type ParsedTheme, type ThemeBase, themeInfo } from "../shared/theme";

/**
 * Every theme the app can find: the 18 shipped under themes/ and
 * whatever the user dropped in `~/.pi/agent/sova/themes/` (the state root moved with the rename).
 * The grammar and the read pipeline are
 * shared/theme.ts's — this module is only the two folders and the order they come back in.
 *
 * There is no watch and no cache: the picker re-fetches every 2s while its tab is visible, and a
 * scan of two small folders is cheaper than the bookkeeping a watch would need to stay honest
 * about a file saved in another window. There is also no selection here — the choice lives in the
 * browser's localStorage, so this server has no idea which theme anyone is wearing.
 */
const BUILTIN_DIR = fileURLToPath(new URL("../themes/", import.meta.url));
/** Read per call, like every other agent-dir path: PI_CODING_AGENT_DIR is what the tests move. */
export const userThemesDir = () => join(stateRoot(), "themes");

/** `dark` and `light` lead the list: they are the two bases, and dark is the default. */
const BASE_IDS: readonly string[] = [DEFAULT_THEME_ID, "light"];

interface Candidate {
  id: string;
  path: string;
  parsed: ParsedTheme;
}

const readOne = (dir: string, file: string): Candidate => {
  const path = join(dir, file);
  let parsed: ParsedTheme;
  try {
    parsed = parseTheme(readFileSync(path, "utf8"));
  } catch (err) {
    // A file we listed but can't read is a broken row too, carrying the reason it gave us.
    parsed = { name: "", base: "dark", tokens: {}, warnings: [], error: (err as Error).message };
  }
  return { id: basename(file, ".json"), path, parsed };
};

/** `*.json` in one folder, sorted by id. A missing folder is empty; anything else is the caller's
    to report — the settings dialog spec keeps the built-ins listed and offers Retry. */
function scan(dir: string): { entries: Candidate[]; error?: string } {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { entries: [] };
    return { entries: [], error: (err as Error).message };
  }
  return { entries: files.sort().map((f) => readOne(dir, f)) };
}

/**
 * The full list, rescanned. A user file whose id matches a built-in REPLACES it and keeps its
 * place in the list, marked so the row can say so; the rest of the user's files follow the
 * shipped ones. Themes stand on the BUILT-IN dark or light either way, because that is what
 * tokens.css paints under `data-theme` — replacing `dark.json` changes that theme, not the base
 * every other theme is written against.
 */
export function listThemes(): ThemeList {
  const builtins = scan(BUILTIN_DIR).entries;
  const user = scan(userThemesDir());
  const baseTokens = new Map<ThemeBase, ThemeTokens>();
  for (const b of ["dark", "light"] as const) baseTokens.set(b, builtins.find((c) => c.id === b)?.parsed.tokens ?? {});
  const tokensFor = (parsed: ParsedTheme) => baseTokens.get(parsed.base) ?? {};

  const byId = new Map<string, ThemeInfo>();
  for (const c of builtins)
    byId.set(c.id, themeInfo({ id: c.id, source: "builtin", path: c.path, parsed: c.parsed, baseTokens: tokensFor(c.parsed) }));
  for (const c of user.entries) {
    const replacesBuiltin = builtins.some((b) => b.id === c.id);
    byId.set(c.id, themeInfo({ id: c.id, source: "user", path: c.path, parsed: c.parsed, baseTokens: tokensFor(c.parsed), replacesBuiltin }));
  }

  const rank = (id: string) => {
    const base = BASE_IDS.indexOf(id);
    if (base >= 0) return base;
    return builtins.some((b) => b.id === id) ? 2 : 3;
  };
  const themes = [...byId.values()].sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
  return { dir: userThemesDir(), themes, ...(user.error ? { error: user.error } : {}) };
}
