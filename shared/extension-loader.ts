// What the page and the server say to each other about Settings → Extensions. Types and one pure rule: no imports, so either side loads it.

/** One row's one state, the first that applies, in this order. */
export type ExtensionRowState = "not-usable" | "folder-not-found" | "needs-newer" | "waiting" | "changed" | "off" | "stopped" | "starting" | "running";

/** What an extension adds, as the review states it. A part it doesn't have is left out. */
export interface ExtensionAsks {
  /** The program and its arguments, as written. */
  program?: string[];
  /** It has a page of its own. */
  page?: boolean;
  /** It has a key: a program it runs, or one you run. */
  key?: boolean;
  cards?: string[];
  commands?: string[];
  /** The commands it offers the Overseer. */
  overseer?: string[];
  /** The screens it adds to. */
  screens?: string[];
  drawings?: string[];
}

export interface ExtensionReview {
  id: string;
  title: string;
  description?: string;
  folder?: string;
  /** The version the review shows: Approve and Install carry it back. */
  version: string;
  asks: ExtensionAsks;
  /** The rules it needs ("1.20"), and this Sova's. */
  needs?: string;
  has: string;
  /** What was left out, and why. */
  leftOut: string[];
  /** It comes back when Sova starts, not by itself at login. */
  noServiceManager?: boolean;
}

/** `POST /api/extensions/inspect`: a folder, or an entry, that can be reviewed; or the one reason it can't. */
export type ExtensionInspect = { ok: true; review: ExtensionReview } | { ok: false; reason: string };

export interface ExtensionRow {
  /** The id on the list; a dropped entry with none has `~<its place on the list>`. */
  key: string;
  id: string;
  title: string;
  folder?: string;
  state: ExtensionRowState;
  /** The state's line, when it has one (a reason, a Stopped's cause). */
  line?: string;
  /** What Sova can't do for it: it runs this program itself. */
  ownProgram?: boolean;
  /** The switch: on the list and not off. Absent when the row has no switch. */
  on?: boolean;
  hasProgram?: boolean;
  hasCards?: boolean;
}

export interface ExtensionsInstalled {
  rows: ExtensionRow[];
  /** Peers' extensions, listed only. */
  others: { id: string; title: string; from: string }[];
  /** This page came through another computer: its name. Every action is refused. */
  through?: string;
  /** This Sova's rules. */
  has: string;
  /** Its home folder, so a row can say `~` before anything else on the page has asked. */
  home: string;
}

/** `"1.20"` → [1, 20], or null when it isn't `<major>.<minor>`. */
export function parseContract(v: unknown): [number, number] | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{1,4})\.(\d{1,4})$/.exec(v);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** Whether `needs` asks for newer rules than `has`, part by part as numbers. */
export function contractTooNew(needs: [number, number], has: [number, number]): boolean {
  return needs[0] > has[0] || (needs[0] === has[0] && needs[1] > has[1]);
}
