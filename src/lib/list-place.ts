/**
 * The list place (§app.extensions/list-place): what an extension declares about the sessions pane's
 * whole list, never per row. One answer, a declaration: the people it knows ({id, name, 2 letters,
 * the callers they type as}), the label key that names a chat's owner, and which person is you.
 * From it Sova draws two things of its own: a person menu in the pane's foot beside the host filter
 * (Everyone first), which narrows the list by each row's owner label the way the host filter does,
 * and a two-letter owner mark on every row whose owner is a declared person, peers' rows included.
 * The transcript reads it too: a message another computer typed says whose it was (personOfCaller).
 *
 * The extension lane is the row place's (createPlaceAnswers in src/lib/row-place.ts): one request per
 * extension whose offers name `list` (GET /ext/<id>/api/screens/list), when the page has its list,
 * when that set of extensions changes, and after the list changes no sooner than every
 * ROW_ASK_MIN_MS; the 2 s timeout, the size cap, the auto-mute and the per-browser off switch are the
 * slot policy's, with this place's own switch. The first extension in manifest order with a good
 * answer is the one declaration. With no extension naming `list` it costs nothing: no request, no
 * state, no timer, and every reader answers null.
 */
import { createContext, createEffect, createMemo, createSignal, on, onCleanup, type Accessor } from "solid-js";
import type { ExtensionInfo, SessionSummary } from "../../shared/protocol";
import { offersPlace, screenPath } from "../../shared/extension-offers";
import { createSlotPolicy, readCappedJson, type SlotPolicy, type SlotStorage } from "./reply-slot";
import { createPlaceAnswers, sameRowExtensions, type RowClock, type RowExtension, type RowSource } from "./row-place";
import { labelsAsk, setLabelsAsk } from "./labels-ask";
import { hostOf } from "./mesh";

/** People read from one answer; the rest make it bad. */
export const LIST_PEOPLE_MAX = 32;
export const LIST_NAME_MAX = 40;
/** Callers one person may be recorded as (senders: `peer:<node id>`, `operator`). */
export const LIST_CALLERS_MAX = 8;
export const LIST_CALLER_MAX = 128;
/** The declaration is small: 64 KB holds 32 people many times over. */
export const LIST_ANSWER_MAX_BYTES = 64 * 1024;
/** Where the user's switch for the list place is kept: apart from the reply and row places'. */
export const LIST_OFF_KEY = "sova.list-place.off";
/** Where the person menu's choice is kept, per browser: the person's id (absent: Everyone). */
export const PERSON_FILTER_KEY = "sova:person-filter";

export interface ListPerson {
  id: string;
  name: string;
  /** Exactly 2 letters or digits, upper-cased. */
  initials: string;
  /** The callers this person types as, matched exactly (`peer:<node id>`, `operator`). */
  callers: string[];
}

export interface ListDeclaration {
  /** The extension that declared it. */
  extension: string;
  extensionTitle: string;
  /** The extension whose labels hold the owner (the declaring one unless it names another). */
  ownerExt: string;
  /** The label key under `ownerExt` whose value is the owner's person id. */
  ownerKey: string;
  people: ListPerson[];
  /** Which person is you: their mark is highlighted. */
  self?: string;
}

const PERSON_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
/** The server's extension id rule (shared/commands-ext.ts). */
const EXT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** A label key (the labels store's rule). */
export const LABEL_KEY_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const INITIALS_RE = /^[\p{L}\p{N}]{2}$/u;
/** Letters, digits, spaces and plain punctuation: the chip rule (src/lib/row-place.ts). */
const PLAIN = /^[\p{L}\p{N} .,:;!?()/+#%_'-]+$/u;
const plainText = (v: unknown, max: number): v is string => typeof v === "string" && v.trim() === v && v.length > 0 && v.length <= max && PLAIN.test(v);

/** One person, or null (dropped alone). */
export function validPerson(raw: unknown): ListPerson | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !PERSON_ID_RE.test(r.id)) return null;
  if (!plainText(r.name, LIST_NAME_MAX)) return null;
  if (typeof r.initials !== "string" || !INITIALS_RE.test(r.initials)) return null;
  const callers: string[] = [];
  if (r.callers !== undefined) {
    if (!Array.isArray(r.callers) || r.callers.length > LIST_CALLERS_MAX) return null;
    for (const c of r.callers) {
      if (typeof c !== "string" || c.length === 0 || c.length > LIST_CALLER_MAX || /\s/.test(c)) return null;
      callers.push(c);
    }
  }
  return { id: r.id, name: r.name, initials: r.initials.toUpperCase(), callers };
}

/**
 * One extension's answer into its declaration, whether any of it was bad, and whether it was
 * malformed (dropped whole: the last good one stays). `null` (a 204) declares nothing, and is no
 * fault: the people go until it declares again. A bad person is dropped alone; a bad
 * `ownerKey`, `ownerExt` or `self`, or no good person at all, drops the whole answer.
 */
export function validateListAnswer(raw: unknown, ext: RowExtension): { answer: ListDeclaration | null; bad: boolean; malformed: boolean } {
  // Nothing to declare (a 204, or `null`): no people, and nothing wrong with saying so.
  if (raw === null) return { answer: null, bad: false, malformed: false };
  const malformed = { answer: null, bad: true, malformed: true };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return malformed;
  const r = raw as Record<string, unknown>;
  if (typeof r.ownerKey !== "string" || !LABEL_KEY_RE.test(r.ownerKey)) return malformed;
  if (r.ownerExt !== undefined && (typeof r.ownerExt !== "string" || !EXT_ID_RE.test(r.ownerExt) || r.ownerExt === "." || r.ownerExt === "..")) return malformed;
  if (!Array.isArray(r.people)) return malformed;
  let bad = r.people.length > LIST_PEOPLE_MAX;
  const people: ListPerson[] = [];
  const ids = new Set<string>();
  for (const p of r.people.slice(0, LIST_PEOPLE_MAX)) {
    const person = validPerson(p);
    if (!person || ids.has(person.id)) {
      bad = true;
      continue;
    }
    ids.add(person.id);
    people.push(person);
  }
  if (!people.length) return malformed;
  if (r.self !== undefined && (typeof r.self !== "string" || !ids.has(r.self))) return malformed;
  const answer: ListDeclaration = { extension: ext.id, extensionTitle: ext.title, ownerExt: (r.ownerExt as string | undefined) ?? ext.id, ownerKey: r.ownerKey, people };
  if (r.self !== undefined) answer.self = r.self as string;
  return { answer, bad, malformed: false };
}

/** The running extensions whose offers name the list place, in manifest order. */
export function listExtensions(list: readonly ExtensionInfo[] | undefined): RowExtension[] {
  const out: RowExtension[] = [];
  for (const e of list ?? []) if (e.status === "ok" && offersPlace(e.offers, "list")) out.push({ id: e.id, title: e.title });
  return out;
}

// ---- reading a row by the declaration (pure) -----------------------------------------------------

/** The person a caller was, by exact match on their `callers`; undefined without a declaration. */
export const personOfCaller = (decl: ListDeclaration | null | undefined, caller: string): ListPerson | undefined =>
  decl ? decl.people.find((p) => p.callers.includes(caller)) : undefined;

/** Parents followed from a helper chat to the chat that owns it, at most (lib/merge-chat's bound). */
export const OWNER_HOPS_MAX = 8;

/** A helper chat's parent among the rows the page holds (its `workerOf`: same host, same id), or undefined. */
export type ParentOf = (s: SessionSummary) => SessionSummary | undefined;

/** The parent lookup over the page's rows: one map, built by the caller only while a declaration exists. */
export function parentLookup(rows: readonly SessionSummary[]): ParentOf {
  const key = (host: string | null, id: string) => `${host ?? ""}\n${id}`;
  const byKey = new Map<string, SessionSummary>();
  for (const r of rows) byKey.set(key(hostOf(r.path), r.id), r);
  return (s) => (s.workerOf ? byKey.get(key(hostOf(s.path), s.workerOf.id)) : undefined);
}

/**
 * A row's owner label as the declaration names it (any host's row: the key is the local declaration's).
 * A helper chat with no owner label of its own follows the chat that started it (`workerOf`, through
 * `parentOf`), at most OWNER_HOPS_MAX parents up: its parent's owner is its owner. A parent the page
 * doesn't hold leaves it unowned.
 */
export const ownerIdOf = (decl: ListDeclaration, s: SessionSummary, parentOf?: ParentOf): string | undefined => {
  let row: SessionSummary | undefined = s;
  for (let hops = 0; row; hops++) {
    const v = row.labels?.[decl.ownerExt]?.[decl.ownerKey];
    if (typeof v === "string") return v;
    if (!parentOf || !row.workerOf || hops >= OWNER_HOPS_MAX) return undefined;
    row = parentOf(row);
  }
  return undefined;
};

/** A row's owner, when the label (its own, or its parent's for a helper chat) names a declared person. */
export const ownerOf = (decl: ListDeclaration | null | undefined, s: SessionSummary, parentOf?: ParentOf): ListPerson | undefined => {
  if (!decl) return undefined;
  const id = ownerIdOf(decl, s, parentOf);
  return id === undefined ? undefined : decl.people.find((p) => p.id === id);
};

/** What the person menu applies: the stored id while the declaration names that person, else Everyone (null). */
export const effectivePersonFilter = (stored: string | null, decl: ListDeclaration | null | undefined): string | null =>
  stored !== null && decl?.people.some((p) => p.id === stored) ? stored : null;

/** Whether a row passes the person menu's choice (null: Everyone, every row). */
export const passesPersonFilter = (decl: ListDeclaration | null | undefined, person: string | null, s: SessionSummary, parentOf?: ParentOf): boolean =>
  person === null || !decl || ownerIdOf(decl, s, parentOf) === person;

/** The `<extension id>:<key>` pairs a declaration reads (lib/labels-ask), or null. */
export const labelPairs = (d: ListDeclaration | null): string | null => (d ? `${d.ownerExt}:${d.ownerKey}` : null);

/** Same declaration, field by field: a re-ask that changes nothing redraws nothing. */
export const sameDeclaration = (a: ListDeclaration | null, b: ListDeclaration | null): boolean => {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.extension === b.extension &&
    a.extensionTitle === b.extensionTitle &&
    a.ownerExt === b.ownerExt &&
    a.ownerKey === b.ownerKey &&
    a.self === b.self &&
    a.people.length === b.people.length &&
    a.people.every((p, i) => {
      const q = b.people[i]!;
      return p.id === q.id && p.name === q.name && p.initials === q.initials && p.callers.length === q.callers.length && p.callers.every((c, j) => c === q.callers[j]);
    })
  );
};

// ---- the page's lane --------------------------------------------------------------------------

const storage = (): SlotStorage | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

/** The list place's switch and mute record for the whole page. */
export const listPolicy = createSlotPolicy(storage(), LIST_OFF_KEY);
const [policyVersion, setPolicyVersion] = createSignal(0);
listPolicy.subscribe(() => setPolicyVersion((v) => v + 1));
/** The user's switch for one extension's declaration, reactive. */
export const listPlaceOff = (id: string): boolean => (policyVersion(), listPolicy.isOff(id));
/** Sova muted its declaration until the page reloads, reactive. */
export const listPlaceMuted = (id: string): boolean => (policyVersion(), listPolicy.isMuted(id));

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** GET /ext/<id>/api/screens/list, through the proxy (which strips Sova's token). No query: per list. */
async function askList(fetch: Fetch, id: string, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(`/ext/${encodeURIComponent(id)}${screenPath("list")}`, { signal, headers: { accept: "application/json" }, credentials: "same-origin" });
  if (res.status === 204) return null;
  return readCappedJson(res, LIST_ANSWER_MAX_BYTES);
}

/** What the page reads of the list place. */
export interface ListPlace {
  /** The one declaration in force, or null (no extension declares one, or it is off or muted). */
  declaration(): ListDeclaration | null;
  /** The declared person a caller was, or undefined. */
  personOfCaller(caller: string): ListPerson | undefined;
  /** This browser had a declaration last time (lib/labels-ask's kept pairs) and nothing has said
      otherwise yet: the pane gives its rows their owner slot from the first draw, so the declaration
      arriving draws the marks without drawing the list again. */
  expected(): boolean;
}

/** No declaration, ever: outside the provider, and the whole page while no extension names `list`. */
export const NO_LIST_PLACE: ListPlace = { declaration: () => null, personOfCaller: () => undefined, expected: () => false };

/** The page's list place, handed down from App to the pane and the transcript. */
export const ListPlaceContext = createContext<ListPlace>(NO_LIST_PLACE);

/** A row's owner as the pane hands it to its rows: the person and whether it is you, or undefined. */
export type OwnerOfRow = (s: SessionSummary) => { person: ListPerson; self: boolean } | undefined;

/** The pane's owner reader for its rows, provided only while a declaration exists: null (the default)
    means a row makes no owner slot at all. */
export const OwnerContext = createContext<OwnerOfRow | null>(null);

/** The page's lane over its list, with the page's extension list (and, for tests, fetch, policy and clock). */
export function createListPlace(opts: {
  sessions: Accessor<readonly SessionSummary[] | undefined>;
  extensions: Accessor<readonly ExtensionInfo[] | undefined>;
  fetch?: Fetch;
  policy?: SlotPolicy;
  clock?: RowClock;
  /** Where the labels the declaration names go (lib/labels-ask; a test's own). */
  readLabels?: (pairs: string | null) => void;
  /** Whether a declaration is expected at first (default: lib/labels-ask kept pairs from last time). */
  expected?: boolean;
}): ListPlace {
  const fetch: Fetch = opts.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const policy = opts.policy ?? listPolicy;
  const sources = createMemo(() => listExtensions(opts.extensions()), [], { equals: sameRowExtensions });
  const [declaration, setDeclaration] = createSignal<ListDeclaration | null>(null, { equals: sameDeclaration });
  const [expected, setExpected] = createSignal(opts.expected ?? labelsAsk() !== null);
  // The rows carry the owner label only while a declaration names it (lib/labels-ask). Said only
  // once it is known: an answer landed, or there is no extension to ask. Until then the pairs kept
  // from last time stand, so a page load that ends where the last one did changes nothing.
  const readLabels = opts.readLabels ?? setLabelsAsk;
  const settle = (d: ListDeclaration | null) => {
    setDeclaration(d);
    readLabels(labelPairs(d));
    if (!d) setExpected(false);
  };
  let lane: ReturnType<typeof createPlaceAnswers<ListDeclaration | null>> | null = null;

  const close = () => {
    lane?.stop();
    lane = null;
    // No extension names `list` in a loaded extension list: known. No list yet: nothing is known.
    if (opts.extensions() !== undefined && !sources().length) settle(null);
    else setDeclaration(null);
  };
  const ask = (soon: boolean) => {
    const list = sources();
    if (!list.length || !opts.sessions()) return close();
    lane ??= createPlaceAnswers(policy, validateListAnswer, (answers) => settle(answers.find(([, d]) => d)?.[1] ?? null), { clock: opts.clock });
    lane.ask(list.map((ext): RowSource => ({ ext, ask: (signal) => askList(fetch, ext.id, signal) })), soon);
  };

  // Whether the list is there yet, and which extensions: at once. The list changing: no sooner than
  // ROW_ASK_MIN_MS after the last ask. With no extension that names `list` neither does anything.
  const hasList = createMemo(() => !!opts.sessions());
  // The extension list loading with no `list` extension in it is news too: last time's pairs go.
  const extensionsKnown = createMemo(() => opts.extensions() !== undefined);
  createEffect(on([hasList, sources, extensionsKnown], () => ask(false)));
  createEffect(on(opts.sessions, () => sources().length > 0 && ask(true), { defer: true }));
  const offPolicy = policy.subscribe(() => lane && ask(true));
  onCleanup(() => {
    offPolicy();
    lane?.stop();
    lane = null;
  });

  return { declaration, personOfCaller: (caller) => personOfCaller(declaration(), caller), expected };
}
