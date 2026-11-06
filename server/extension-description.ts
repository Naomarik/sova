// An extension's folder and its description file (§app.extensions/folder). Reading a folder runs nothing:
// it reads that one file and checks the paths it names. The first thing that fails is the one answer, in the
// words of §design.copy-deck/settings-extensions. One bad command, screen, card or drawing leaves out only
// itself, by the same rules a list entry is read with, and the review says so on screen.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { offersOf } from "../shared/extension-offers";
import { contractTooNew, parseContract, type ExtensionAsks } from "../shared/extension-loader";
import { EXTENSION_DESCRIPTION } from "./extension-fingerprint";
import { viewOffersOf } from "./extension-views";
import { contractWords, EXTENSION_CONTRACT, EXTENSION_ID_RE, listedExtensions, plainTitle, TITLE_MAX } from "./extensions";

const KEYS = new Set(["version", "id", "title", "description", "icon", "needsContract", "page", "backend", "commands", "screens", "cards", "drawings"]);
const BACKEND_KEYS = new Set(["run", "folder"]);

/** What a folder describes, as the list entry it becomes (no `api`: Sova assigns that). */
export interface Described {
  entry: Record<string, unknown> & { id: string; title: string; folder: string };
  leftOut: string[];
  asks: ExtensionAsks;
  needs: string;
}

const inFolder = (folder: string, rel: string): string | null => {
  if (isAbsolute(rel)) return null;
  try {
    const root = realpathSync(folder);
    const real = realpathSync(join(root, rel));
    return real === root || real.startsWith(root + sep) ? resolve(folder, rel) : null;
  } catch {
    return null;
  }
};

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const nonEmpty = (v: unknown): boolean => Array.isArray(v) && v.length > 0;

/** What the review states: what an entry validly offers, and what was left out of it. */
export function asksOf(raw: Record<string, unknown>, id: string, title: string): { asks: ExtensionAsks; leftOut: string[] } {
  const dist = typeof raw.dist === "string" ? raw.dist : undefined;
  const { offers, dropped } = offersOf(id, raw);
  const views = viewOffersOf({ id, title, ...(dist ? { dist } : {}) }, raw);
  const commands = offers?.commands ?? [];
  const overseer = commands.filter((c) => c.overseer);
  const asks: ExtensionAsks = {
    ...(Array.isArray(raw.run) ? { program: raw.run as string[] } : {}),
    ...(dist ? { page: true } : {}),
    ...(raw.run !== undefined || raw.api !== undefined ? { key: true } : {}),
    ...(views.offers.cards?.length ? { cards: views.offers.cards.map((c) => c.title) } : {}),
    ...(commands.length ? { commands: commands.map((c) => c.label) } : {}),
    ...(overseer.length ? { overseer: overseer.map((c) => c.label) } : {}),
    ...(offers?.screens?.length ? { screens: offers.screens } : {}),
    ...(views.offers.drawings?.length ? { drawings: views.offers.drawings.map((d) => d.kind) } : {}),
  };
  return { asks, leftOut: [...dropped, ...views.dropped] };
}

/** One folder → what it describes, or the one reason it can't be used. `self`: the id the choosing row has already. */
export function readDescription(folderIn: string, self?: string): { ok: true; described: Described } | { ok: false; reason: string } {
  const bad = (reason: string) => ({ ok: false as const, reason });
  const folder = resolve(folderIn);
  const file = join(folder, EXTENSION_DESCRIPTION);
  if (!existsSync(file)) return bad("This folder has no extension description (sova-extension.json), so it can't be added.");
  let d: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return bad("Its description can't be read: it isn't a JSON object.");
    d = parsed as Record<string, unknown>;
  } catch (err) {
    return bad(`Its description can't be read: ${(err as Error).message}.`);
  }
  // Read first, so a newer file says it needs a newer Sova and not that it is broken.
  const needs = parseContract(d.needsContract);
  if (!needs) return bad("Its description doesn't say which Sova it needs.");
  if (contractTooNew(needs, [1, EXTENSION_CONTRACT])) return bad(`This needs a newer Sova (${d.needsContract as string}; this one has ${contractWords()}).`);
  for (const k of Object.keys(d)) if (!KEYS.has(k)) return bad(`Its description has a key Sova doesn't know: ${k}.`);
  const usable = (field: string, why: string) => bad(`Its description can't be used: ${field} ${why}.`);
  if (d.version !== 1) return usable("version", "must be 1");
  if (typeof d.id !== "string" || !EXTENSION_ID_RE.test(d.id) || d.id === "." || d.id === "..") return usable("id", "may hold only letters, digits, dots, dashes and underscores");
  const title = typeof d.title === "string" ? d.title.trim() : "";
  if (!title || !plainTitle(title)) return usable("title", `must be one line of at most ${TITLE_MAX} characters`);
  const entry: Described["entry"] = { id: d.id, title, folder };
  if (typeof d.description === "string" && d.description.trim()) entry.description = d.description.trim();
  if (typeof d.icon === "string") entry.icon = d.icon;
  entry.needsContract = d.needsContract;
  if (d.page !== undefined) {
    const dist = typeof d.page === "string" ? inFolder(folder, d.page) : null;
    if (!dist) return usable("page", "must be a folder inside this one");
    if (!isDir(dist) || !existsSync(join(dist, "index.html"))) return usable("page", "must hold an index.html");
    entry.dist = dist;
  }
  let hasBackend = false;
  if (d.backend !== undefined) {
    const b = d.backend as Record<string, unknown> | null;
    if (typeof b !== "object" || b === null || Array.isArray(b)) return usable("backend", "must be an object with run");
    for (const k of Object.keys(b)) if (!BACKEND_KEYS.has(k)) return bad(`Its description has a key Sova doesn't know: backend.${k}.`);
    if (!Array.isArray(b.run) || !b.run.length || b.run.some((w) => typeof w !== "string" || !w)) return usable("backend", "run must be the program and its arguments, as words");
    entry.run = b.run;
    if (b.folder !== undefined) {
      const program = typeof b.folder === "string" ? inFolder(folder, b.folder) : null;
      if (!program || !isDir(program)) return usable("backend", "folder must be a folder inside this one");
      entry.programFolder = program;
    }
    hasBackend = true;
  }
  if (d.id.toLowerCase() === "project") return bad("The name project is Sova's own, so this can't be added.");
  if (d.id !== self) {
    const taken = (listedExtensions() ?? []).find((l) => l.valid?.entry.id === d.id && (l.raw.folder === undefined || resolve(l.raw.folder as string) !== folder));
    if (taken) return bad(`There's already an extension named ${d.id}, from ${typeof taken.raw.folder === "string" ? taken.raw.folder : "the list"}.`);
  }
  if (!hasBackend && (nonEmpty(d.commands) || nonEmpty(d.screens))) return bad("It lists commands or screens but no program to answer them.");
  for (const k of ["commands", "screens", "cards", "drawings"]) if (d[k] !== undefined) entry[k] = d[k];
  const { asks, leftOut } = asksOf(entry, d.id, title);
  return { ok: true, described: { entry, leftOut, asks, needs: d.needsContract as string } };
}
