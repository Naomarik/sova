// Pure words and choices for a chat's profile switch (§chat.profiles/switch, §chat.profiles/edited,
// §chat.subagent-profiles/limit-row). DOM- and Solid-free, so the unit tier tests it directly.

import { profileMinors, startsFrom, type ChatStarts, type Profile } from "../../shared/profiles";

/** The fields of a joined profile row these helpers read (shared/profiles.ts JoinedProfile). */
export interface SwitchRow {
  key: string;
  id: string;
  kind: string;
  group: string;
  name: string;
  /** Canonical providers of every model in its Models part, the chat's own model included. */
  providers?: readonly string[];
  /** Whether it sets the chat's own model (its This chat row). */
  setsModel?: boolean;
  hidden?: true;
  unusable?: string;
  approval?: "needed" | "approved";
  /** The built-in one this row of yours takes the place of ("sova:<id>"). */
  replaces?: string;
}

/** A profile of yours in a built-in one's place, an edited built-in one (§chat.subagent-profiles/edited-builtin):
    listed where the built-in one was, under Built in, with a Yours chip. */
export const isEditedBuiltin = (r: { group: string; replaces?: string }): boolean => r.group === "yours" && !!r.replaces;

/** The order Sova ships its built-in profiles in; an edited one takes its built-in one's place in it. */
const BUILTIN_ORDER = ["claude", "openai", "deepseek"];
const builtinRank = (r: { id: string; replaces?: string }) => {
  const i = BUILTIN_ORDER.indexOf(r.replaces ? r.replaces.slice("sova:".length) : r.id);
  return i < 0 ? BUILTIN_ORDER.length : i;
};

/** The rows listed under Built in: the shipped ones and the edited ones in their places, in Sova's order (stable). */
export function builtinGroup<T extends { id: string; group: string; replaces?: string }>(rows: readonly T[]): T[] {
  return rows
    .filter((r) => r.group === "builtin" || isEditedBuiltin(r))
    .map((r, i) => ({ r, i }))
    .sort((a, b) => builtinRank(a.r) - builtinRank(b.r) || a.i - b.i)
    .map((x) => x.r);
}

/** Whether a chat's `chat_profile` names a profile: none with no profile at all (no account connected
    and none of yours as the default, or an older server's Off), so the menu then says no profile word. */
export const namesProfile = (c: { id: string; key?: string; name: string } | null | undefined): boolean =>
  !!c && c.id !== "off" && c.key !== "sova:default" && c.name.trim() !== "";

/** "{name} (edited)" while the chat's model isn't the one its profile sets. */
export const editedName = (name: string, edited: boolean): string => (edited ? `${name} (edited)` : name);

/** The line above the composer while a switch waits for the reply to end. */
export function switchWaitingLine(name: string, helpers: number, setsModel: boolean): string {
  const moved = [...(setsModel ? ["this chat's model"] : []), ...(helpers > 0 ? [`its ${helpers} helper${helpers === 1 ? "" : "s"}`] : []), "alignment settings"];
  if (moved.length === 1) return `Switching to ${name} when this chat is free. Moves its alignment settings. Tools and modes stay.`;
  const list = moved.length === 3 ? `${moved[0]}, ${moved[1]}, and ${moved[2]}` : `${moved[0]} and ${moved[1]}`;
  return `Switching to ${name} when this chat is free. Moves ${list}. Tools and modes stay.`;
}

/** The line above the composer once a switch applied (also announced). */
export const switchedLine = (name: string): string => `This chat and its helpers are on ${name}.`;

/** A refused switch's banner: nothing changed. */
export function switchRefused(name: string, reason: string): { title: string; body: string } {
  return { title: `Couldn't switch to ${name}.`, body: `${reason.trim().replace(/\.$/, "")}. This chat's model and helpers are unchanged.` };
}

/** The limit row's sentence: the reset time only when Sova knows it from the provider. */
export function limitLine(model: string, resetsIn?: string | null): string {
  return `${model} is at its usage limit.${resetsIn ? ` It resets in ${resetsIn}.` : ""}`;
}

/**
 * The limit row's offers (§chat.subagent-profiles/limit-row): up to two profiles, yours in list
 * order then the built-in ones, whose Models part (the chat's own model included) uses no model of
 * the exhausted provider. The chat's current profile only while the chat reads "(edited)". A row that sets no
 * model for the chat is never offered: switching to it would leave the chat on the limited model.
 * Neither is a hidden, unusable or unapproved one.
 */
export function limitOffers<T extends SwitchRow>(rows: readonly T[], exhausted: string, current: { key: string | null; edited: boolean }, max = 2): T[] {
  const usable = rows
    .filter((r) => r.kind !== "off" && !r.hidden && !r.unusable && r.approval !== "needed")
    .filter((r) => r.setsModel === true && (r.providers?.length ?? 0) > 0 && !r.providers!.includes(exhausted))
    .filter((r) => r.key !== current.key || current.edited);
  return [...usable.filter((r) => r.group === "yours"), ...usable.filter((r) => r.group === "builtin")].slice(0, max);
}

/** The picker's rows: yours, then this project's, then the built-in ones (an edited built-in one among them, in its
    place); hidden rows left out, and no row for no profile (an older server's Off). */
export function pickerRows<T extends SwitchRow>(rows: readonly T[]): T[] {
  const rest = rows.filter((r) => r.kind !== "off" && !r.hidden);
  return [...rest.filter((r) => r.group === "yours" && !isEditedBuiltin(r)), ...rest.filter((r) => r.group === "project"), ...builtinGroup(rest)];
}

/** Why a picker row can't be picked here, or null. */
export const rowDisabledReason = (r: SwitchRow): string | null => (r.approval === "needed" ? "Approve it in Settings first" : (r.unusable ?? null));

/** What a picked row does to this chat: nothing (its own profile, not edited), or a switch. */
export const pickDoesSomething = (r: Pick<SwitchRow, "key">, current: { key: string | null; edited: boolean }): boolean => r.key !== current.key || current.edited;

/** "New chat in {project}. The default is already picked." */
export const newChatLine = (project: string | null | undefined): string => (project ? `New chat in ${project}. The default is already picked.` : "New chat. The default is already picked.");

/**
 * The picker's new chat line, or null: none when there is no default profile, nor when the default couldn't be
 * applied (the empty screen's warn line says so, and "already picked" would contradict it).
 */
export const pickerNewChatLine = (o: { hasDefault: boolean; project: string | null | undefined; defaultNotApplied?: unknown }): string | null =>
  o.hasDefault && !o.defaultNotApplied ? newChatLine(o.project) : null;

/** What Update {name} compares: what a new chat on this chat's profile starts with against the chat now. */
export interface UpdateSides {
  /** The server's answer for this chat's profile (startsOfRow); null or undefined: not known yet. */
  starts: ChatStarts | null | undefined;
  chat: { model?: string | null; thinking?: string | null; mode?: string | null; minorModes?: readonly string[] | null };
}

/**
 * What a new chat on `row` starts with, as the server opens one: its session half over the listing's
 * `startsBase` (shared/profiles startsFrom, the server's own rule). From an older server with no
 * `startsBase`, only what the half itself sets, so a field it leaves unset is never a difference.
 */
export function startsOfRow(row: { session?: Pick<Profile, "mode" | "minorModes" | "model" | "thinking"> } | null | undefined, base: ChatStarts | null | undefined): Partial<ChatStarts> | null {
  if (!row) return null;
  if (base) return startsFrom(row.session, base);
  const h = row.session;
  return { ...(h?.mode ? { mode: h.mode } : {}), ...(h?.minorModes ? { minorModes: profileMinors(h.minorModes) } : {}), ...(h?.model ? { model: h.model } : {}), ...(h?.thinking ? { thinking: h.thinking } : {}) };
}

/**
 * Whether Update {name} is offered (§chat.subagent-profiles/menu): for one of yours or a built-in
 * one (whose first save makes it yours), never a project's file, while saving would change what a
 * new chat on it starts with: its mode, its add-on modes (only those a profile can hold: memory and
 * project modes never count), its model or effort. Unknown on either side is no difference.
 */
export function updateOffered(row: Pick<SwitchRow, "kind" | "group" | "unusable"> | null | undefined, s: { starts: Partial<ChatStarts> | null | undefined; chat: UpdateSides["chat"] }): boolean {
  if (!row || (row.group !== "yours" && row.group !== "builtin") || row.kind === "off" || row.unusable) return false;
  const p = s.starts;
  if (!p) return false;
  const c = s.chat;
  const differs = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a !== b;
  const minors = (a: readonly string[] | null | undefined, b: readonly string[] | null | undefined) => {
    if (!a || !b) return false;
    const x = profileMinors(a);
    const y = profileMinors(b);
    return x.length !== y.length || x.some((m) => !y.includes(m));
  };
  return differs(p.model, c.model) || differs(p.thinking, c.thinking) || differs(p.mode, c.mode) || minors(p.minorModes, c.minorModes);
}

/** What a card pick sends for a joined row (POST /api/sessions/profile): a library profile no
    session profile links is picked with its helpers only, any other by its session half. */
export type CardPickRef = { source: "sova" | "user" | "project" | "library"; id: string };
export function cardPickRef(r: { kind: string; id: string; libraryId?: string; session?: { source: "sova" | "user" | "project"; id: string } }): CardPickRef {
  if (r.kind === "library") return { source: "library", id: r.libraryId ?? r.id };
  return r.session ? { source: r.session.source, id: r.session.id } : { source: "user", id: r.id };
}

/**
 * A pick in the mode menu's picker (§chat.profiles/switch): before the chat's first message it is
 * exactly a card pick, both parts (§chat.profiles/applying), so the empty screen's card, its details
 * and the menu name one profile; after it, the switch of the Models part. Errors are the caller's.
 */
export async function menuPick<S>(
  r: { kind: string; id: string; libraryId?: string; session?: { source: "sova" | "user" | "project"; id: string } },
  beforeFirstMessage: boolean,
  io: { pick: (ref: CardPickRef) => Promise<unknown>; switchTo: (id: string) => Promise<S> },
): Promise<{ kind: "card" } | { kind: "switch"; result: S }> {
  if (beforeFirstMessage) {
    await io.pick(cardPickRef(r));
    return { kind: "card" };
  }
  return { kind: "switch", result: await io.switchTo(r.id) };
}
