import type { SubagentProfile } from "../../shared/subagent-profiles";
import type { DelegateBackendId, WorkerChoice } from "../../shared/protocol";
import { DEFAULT_LIMITS, KEEPS_OWN_MODEL, LIMIT_KEYS, LIMIT_LABEL, type ProfileLimits, OFF_KEY, type JoinedProfile, type Profile, type ProfileStarts, type ThinkingLevel } from "../../shared/profiles";
import { check, type FieldCheck, type WholeRule } from "../../shared/form-rules";
import { TEAM_NUMBERS, TEAM_RULES, type TeamNumberField } from "../../shared/subagent-limits";
import { PROFILE_LABEL_RULE, PROFILE_NAME_OFF, PROFILE_NAME_TAKEN, PROFILE_READ_RULE } from "../../shared/profile-limits";
import { profilesFields } from "./subagent-profiles-draft";
import { footprintModel } from "./subagent-editor";

/**
 * Settings → Profiles' rules, apart from its markup (§app.settings-dialog/profiles,
 * §app.settings-dialog/profile-editor): the draft of your own profiles (both halves, joined by
 * link), the list's groups, Set All To, the footprint of an edited profile, "Also used by", and what
 * Save waits for. Pure: the store and the screen import it; the tests drive it.
 */

/** A profile's Models part beyond the chat's own model: a library profile less its id and name. */
export type Helpers = Omit<SubagentProfile, "id" | "name">;
/** A profile's When a Chat Starts part: the session profile less its name, model, effort and link. */
export type Starts = ProfileStarts;
export { OFF_KEY };

/** One of yours as the draft holds it. */
export interface DraftRow {
  /** The joined key once saved ("user:<id>", "library:<id>"); "new:<n>" until Save Changes. */
  key: string;
  name: string;
  /** null: no session half yet (a library profile no session profile links). */
  starts: Starts | null;
  /** The chat's own model ref and effort; null = keeps the chat's own (an effort: the model's default).
      "" = no effort chosen yet (Set All To blanked one the new model doesn't take): Save waits. */
  model: string | null;
  thinking: ThinkingLevel | "" | null;
  /** The helper half it links, a key of `library`; null = no helpers (this computer's default's). */
  lib: string | null;
}

/** The Profiles form's draft: your profiles, the library halves they link, and this computer's default. */
export interface ProfilesDraft {
  /** A joined key, or OFF_KEY. */
  default: string;
  rows: DraftRow[];
  /** Library halves by id ("new:<n>" for one not saved yet). */
  library: Record<string, Helpers>;
}

/** The joined row as the listing sends it. */
export type JoinedRowWire = JoinedProfile;

export const isNewKey = (key: string): boolean => key.startsWith("new:");
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** JSON with every object's keys sorted, so two drafts saying the same thing compare equal whatever order a field was set in. */
export function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x,
  );
}

export const helpersOf = (p: SubagentProfile): Helpers => {
  const { id: _id, name: _name, ...rest } = clone(p);
  return rest;
};
export const startsOf = (p: Profile): Starts => {
  const s: Starts = { icon: p.icon, description: p.description, remove: [...p.remove], grant: [...p.grant], singleton: p.singleton, limits: { ...p.limits }, overseerMayStart: p.overseerMayStart };
  if (p.mode === "normal" || p.mode === "delegate") s.mode = p.mode;
  if (p.minorModes !== undefined) s.minorModes = [...p.minorModes];
  if (p.firstMessage !== undefined) s.firstMessage = p.firstMessage;
  return s;
};
/** A new profile's When a Chat Starts: nothing removed or granted, the session defaults. */
export const plainStarts = (): Starts => ({ icon: "grid", description: "", remove: [], grant: [], singleton: false, limits: { ...DEFAULT_LIMITS }, overseerMayStart: false });

/** The draft of what's saved: every one of yours, and each library half once. */
export function draftOf(rows: readonly JoinedRowWire[], defaultKey: string): ProfilesDraft {
  const out: ProfilesDraft = { default: defaultKey, rows: [], library: {} };
  for (const r of rows) {
    if (r.group !== "yours" || r.kind === "off") continue;
    const lib = r.library ? (r.libraryId ?? r.library.id) : null;
    if (r.library && lib && !out.library[lib]) out.library[lib] = helpersOf(r.library);
    out.rows.push({
      key: r.key,
      name: r.name,
      starts: r.session ? startsOf(r.session) : null,
      model: r.session?.model ?? null,
      thinking: r.session?.thinking ?? null,
      lib,
    });
  }
  return out;
}

/** "Also used by {name}" for the profiles sharing `row`'s library half (§design.copy-deck/profiles), or null. */
export function alsoUsedBy(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  if (names.length === 1) return `Also used by ${names[0]}`;
  if (names.length === 2) return `Also used by ${names[0]} and ${names[1]}`;
  return `Also used by ${names[0]} and ${names.length - 1} others`;
}

/** The other profiles linking `row`'s library half: yours in the draft, then the project's that link it. */
export function sharersOf(d: ProfilesDraft, key: string, others: readonly JoinedRowWire[] = []): string[] {
  const row = d.rows.find((r) => r.key === key);
  if (!row?.lib) return [];
  const mine = d.rows.filter((r) => r.key !== key && r.lib === row.lib).map((r) => r.name);
  const theirs = others.filter((r) => r.group === "project" && r.libraryId === row.lib).map((r) => r.name);
  return [...mine, ...theirs];
}

/** The helper roles that hold a model, in the editor's order. */
function helperChoices(h: Helpers): WorkerChoice[] {
  const out: WorkerChoice[] = [];
  for (const k of ["planning", "investigation", "routine", "complex"] as const) if (h.delegate[k]) out.push(h.delegate[k].primary);
  if (h.teams) out.push(h.teams.coordinator.primary as WorkerChoice, h.teams.monitor.primary as WorkerChoice);
  if (h.members) out.push(h.members);
  if (h.specWriter) out.push(h.specWriter.primary);
  if (h.reviewer) out.push(h.reviewer.primary);
  return out;
}

/** A model ref's shortest name: a Claude model by its catalog name, else its id without the provider. */
const short = (ref: string): string => footprintModel(ref.startsWith(`${CLAUDE_PROVIDER}/`) ? ref.slice(CLAUDE_PROVIDER.length + 1) : ref);

/** The footprint of a draft row (§chat.profiles/joined): its distinct models, the chat's own first, at most 3 then "+N". */
export function footprintOfDraft(row: DraftRow, helpers: Helpers | undefined): string {
  const names: string[] = [];
  const add = (m: string | null | undefined) => {
    if (!m) return;
    const n = short(m);
    if (!names.includes(n)) names.push(n);
  };
  add(row.model);
  if (helpers) for (const c of helperChoices(helpers)) add(c.model);
  if (names.length === 0) return KEEPS_OWN_MODEL;
  return names.length > 3 ? `${names.slice(0, 3).join(" + ")} +${names.length - 3}` : names.join(" + ");
}

export type ListGroup = "yours" | "project" | "builtin";
export interface ListRow {
  key: string;
  name: string;
  footprint: string;
  group: ListGroup;
  isDefault: boolean;
  needsApproval: boolean;
  hidden: boolean;
  /** Not saved yet (a new profile): Hide waits for Save. */
  unsaved: boolean;
  wire?: JoinedRowWire;
}

/**
 * The list beside the editor: Yours (the draft's, in its order, a new one last), This project, then
 * Built in with Off first. A saved row unchanged in the draft keeps the server's footprint.
 */
export function listGroups(d: ProfilesDraft, wire: readonly JoinedRowWire[], saved: ProfilesDraft | null): Record<ListGroup, ListRow[]> {
  const byKey = new Map(wire.map((w) => [w.key, w]));
  const savedRow = (key: string) => saved?.rows.find((r) => r.key === key);
  const yours = d.rows.map((r): ListRow => {
    const w = byKey.get(r.key);
    const s = savedRow(r.key);
    const same = !!w && !!s && canonical(s) === canonical(r) && canonical(r.lib ? saved?.library[r.lib] : null) === canonical(r.lib ? d.library[r.lib] : null);
    return {
      key: r.key,
      name: r.name,
      footprint: same ? w!.footprint : footprintOfDraft(r, r.lib ? d.library[r.lib] : undefined),
      group: "yours",
      isDefault: d.default === r.key,
      needsApproval: false,
      hidden: !!w?.hidden,
      unsaved: isNewKey(r.key),
      wire: w,
    };
  });
  const fromWire = (w: JoinedRowWire, group: ListGroup): ListRow => ({
    key: w.key,
    name: w.name,
    footprint: w.footprint,
    group,
    isDefault: d.default === w.key,
    needsApproval: w.approval === "needed",
    hidden: !!w.hidden,
    unsaved: false,
    wire: w,
  });
  const project = wire.filter((w) => w.group === "project").map((w) => fromWire(w, "project"));
  const off = wire.find((w) => w.kind === "off");
  const builtin = [
    off ? fromWire(off, "builtin") : { key: OFF_KEY, name: "Off", footprint: KEEPS_OWN_MODEL, group: "builtin" as const, isDefault: d.default === OFF_KEY, needsApproval: false, hidden: false, unsaved: false },
    ...wire.filter((w) => w.group === "builtin" && w.kind !== "off").map((w) => fromWire(w, "builtin")),
  ];
  return { yours, project, builtin };
}

/** The pi provider whose models are Claude Code's (`claude-code-cli/<id>`). */
export const CLAUDE_PROVIDER = "claude-code-cli";
/** A helper's pick as the chat's own model ref: a Claude Code model runs under its provider, a pi model is its ref. */
export const chatRefOf = (backend: DelegateBackendId, model: string): string => (backend === "claude-code" ? `${CLAUDE_PROVIDER}/${model}` : model);
/** The chat's own model ref as a helper's pick. */
export function choiceOfRef(ref: string): { backend: DelegateBackendId; model: string } {
  return ref.startsWith(`${CLAUDE_PROVIDER}/`) ? { backend: "claude-code", model: ref.slice(CLAUDE_PROVIDER.length + 1) } : { backend: "pi", model: ref };
}

/** What Set All To needs to know: the efforts a helper's model takes and the chat's thinking ladder for a ref (null: can't say, keeps it). */
export interface SetAllLookup {
  efforts(backend: DelegateBackendId, model: string): readonly string[] | null;
  levels(ref: string): readonly string[] | null;
}

/**
 * Set All To (§app.settings-dialog/profile-set-all): every model row of `key`'s Models part, This
 * chat included, to `pick`, on the model's own backend; each row keeps its effort where the new
 * model takes it and is left blank otherwise (so Save waits, as one row's model change does). A
 * row that holds no model (a spec writer that is off, the members default on the lead's model,
 * the team roles on the default model) stays as it is: it has nothing to change. Fallbacks stay.
 */
export function setAllTo(d: ProfilesDraft, key: string, pick: { backend: DelegateBackendId; model: string }, look: SetAllLookup): ProfilesDraft {
  const next = clone(d);
  const row = next.rows.find((r) => r.key === key);
  if (!row) return d;
  const ref = chatRefOf(pick.backend, pick.model);
  const levels = look.levels(ref);
  row.model = ref;
  // As a helper row's: an effort the new model doesn't take is left blank, and Save waits for one.
  if (row.thinking && levels !== null && !levels.includes(row.thinking)) row.thinking = "";
  if (row.starts === null) row.starts = plainStarts();
  const h = row.lib ? next.library[row.lib] : undefined;
  if (h) {
    const efforts = look.efforts(pick.backend, pick.model);
    const to = (c: { backend: DelegateBackendId; model: string; effort?: string }) => {
      const effort = c.effort ?? "";
      c.backend = pick.backend;
      c.model = pick.model;
      c.effort = efforts === null || efforts.includes(effort) ? effort : "";
    };
    for (const k of Object.keys(h.delegate) as (keyof Helpers["delegate"])[]) to(h.delegate[k].primary);
    if (h.teams) {
      to(h.teams.coordinator.primary as WorkerChoice);
      to(h.teams.monitor.primary as WorkerChoice);
    }
    if (h.members) to(h.members);
    if (h.specWriter) to(h.specWriter.primary);
    if (h.reviewer) to(h.reviewer.primary);
  }
  return next;
}

/** "New profile", then "New profile 2", … — the first one no profile of yours has. */
export function newProfileName(d: ProfilesDraft, base = "New profile"): string {
  const taken = new Set(d.rows.map((r) => r.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
}
let seq = 0;
const newKey = () => `new:${Date.now().toString(36)}${(seq++).toString(36)}`;

/**
 * New Profile (§app.settings-dialog/profiles): under Yours, named "New profile", with the models of
 * `from` (the profile open in the editor, or the default's when Off is) and plain When a Chat Starts;
 * both halves, linked, saved with Save Changes. `fallbackHelpers` is the library's template, for a
 * source with no helpers. Answers the new draft and the new row's key.
 */
export function withNewProfile(
  d: ProfilesDraft,
  from: { model: string | null; thinking: DraftRow["thinking"]; helpers: Helpers | null; starts?: Starts | null; name?: string } | null,
  fallbackHelpers: Helpers | null,
): { draft: ProfilesDraft; key: string } {
  const next = clone(d);
  const key = newKey();
  const helpers = from?.helpers ?? fallbackHelpers;
  const lib = helpers ? key : null;
  if (lib && helpers) next.library[lib] = clone(helpers);
  next.rows.push({ key, name: newProfileName(d, from?.name ?? "New profile"), starts: from?.starts ? clone(from.starts) : plainStarts(), model: from?.model ?? null, thinking: from?.thinking ?? null, lib });
  return { draft: next, key };
}

/** Duplicate: "{name} copy", both halves copied (its own library half, never shared with the original). */
export function withDuplicate(d: ProfilesDraft, key: string, fallbackHelpers: Helpers | null): { draft: ProfilesDraft; key: string } {
  const row = d.rows.find((r) => r.key === key);
  if (!row) return { draft: d, key };
  return withNewProfile(d, { model: row.model, thinking: row.thinking, helpers: row.lib ? (d.library[row.lib] ?? null) : null, starts: row.starts, name: `${row.name} copy` }, row.lib ? fallbackHelpers : null);
}

/** Delete: refused for the default; a library half another profile still links stays. */
export function withDeleted(d: ProfilesDraft, key: string): ProfilesDraft | string {
  if (d.default === key) return "Make another profile the default first.";
  const next = clone(d);
  const row = next.rows.find((r) => r.key === key);
  next.rows = next.rows.filter((r) => r.key !== key);
  if (row?.lib && !next.rows.some((r) => r.lib === row.lib)) delete next.library[row.lib];
  return next;
}

/** Each team number box's typed text as its number, so a draft compares and saves as the file holds it. */
export function typedHelpers(h: Helpers): Helpers {
  const out = clone(h);
  for (const f of Object.keys(TEAM_RULES) as TeamNumberField[]) {
    const path = TEAM_NUMBERS[f].path;
    const parent = path.slice(0, -1).reduce<any>((o, k) => o?.[k], out.teams);
    const r = parent ? check(TEAM_RULES[f], parent[path.at(-1)!]) : null;
    if (r?.ok) parent[path.at(-1)!] = r.value;
  }
  return out;
}
/** The session powers' limit boxes (§chat.profiles/limits): whole numbers from 1 to 10000, the profile parse's rule. */
export const LIMIT_RULES: Record<keyof ProfileLimits, WholeRule> = Object.fromEntries(LIMIT_KEYS.map((k) => [k, { kind: "whole", label: LIMIT_LABEL[k], min: 1, max: 10_000 }])) as Record<keyof ProfileLimits, WholeRule>;
/** Each limit box's typed text as its number. */
function typedStarts(s: Starts | null): Starts | null {
  if (!s) return s;
  const out = clone(s);
  for (const k of LIMIT_KEYS) {
    const r = check(LIMIT_RULES[k], (out.limits as unknown as Record<string, unknown>)[k]);
    if (r.ok) out.limits[k] = r.value as number;
  }
  return out;
}
export const typedDraft = (d: ProfilesDraft): ProfilesDraft => ({
  ...d,
  rows: d.rows.map((r) => ({ ...r, starts: typedStarts(r.starts) })),
  library: Object.fromEntries(Object.entries(d.library).map(([k, h]) => [k, typedHelpers(h)])),
});

/** Why profile `key`'s name can't be saved beyond its length: the rule's own words, or null. */
export function nameIssue(d: ProfilesDraft, key: string): string | null {
  const row = d.rows.find((r) => r.key === key);
  if (!row?.name) return null;
  if (row.name.trim() !== row.name || /[\x00-\x1f]/.test(row.name)) return "Profile name must be one line, with no spaces at either end.";
  if (row.name.toLowerCase() === "off") return PROFILE_NAME_OFF;
  if (d.rows.some((x) => x.key !== key && x.name.toLowerCase() === row.name.toLowerCase())) return PROFILE_NAME_TAKEN;
  return null;
}

/**
 * Every profile's checks in list order: the name (48 characters for a new or renamed one; an older
 * session profile's longer name reads until renamed, §chat.profiles/profile-name), then its library
 * half's rows, members, team boxes and role names, each said once for a shared half.
 */
export function profilesDraftFields(d: ProfilesDraft, saved: ProfilesDraft | null): (FieldCheck | { message: string | null })[] {
  const seen = new Set<string>();
  return d.rows.flatMap((row) => {
    const before = saved?.rows.find((r) => r.key === row.key);
    const renamed = !before || before.name !== row.name;
    const out: (FieldCheck | { message: string | null })[] = [
      { rule: renamed ? PROFILE_LABEL_RULE : PROFILE_READ_RULE, value: row.name },
      { message: nameIssue(d, row.key) },
    ];
    out.push({ message: row.model && row.thinking === "" ? `${row.name}'s This chat rows each need a model and an effort.` : null });
    if (row.starts?.grant.length) for (const k of LIMIT_KEYS) out.push({ rule: LIMIT_RULES[k], value: (row.starts.limits as unknown as Record<string, unknown>)[k], label: `${row.name}'s ${LIMIT_LABEL[k]}` });
    const h = row.lib ? d.library[row.lib] : undefined;
    if (h && row.lib && !seen.has(row.lib)) {
      seen.add(row.lib);
      // profilesFields' first two are the library's own name checks, which ours replace.
      out.push(...profilesFields({ version: 1, default: "off", profiles: [{ ...h, id: "x", name: row.name || "This profile" }] }).slice(2));
    }
    return out;
  });
}
