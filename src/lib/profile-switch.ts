// Pure words and choices for a chat's profile switch (§chat.profiles/switch, §chat.profiles/edited,
// §chat.subagent-profiles/limit-row). DOM- and Solid-free, so the unit tier tests it directly.

/** The fields of a joined profile row these helpers read (shared/profiles.ts JoinedProfile). */
export interface SwitchRow {
  key: string;
  id: string;
  kind: string;
  group: string;
  name: string;
  /** Canonical providers of every model in its Models part, the chat's own model included. */
  providers?: readonly string[];
  hidden?: true;
  unusable?: string;
  approval?: "needed" | "approved";
}

/** "{name} (edited)" while the chat's model isn't the one its profile sets. */
export const editedName = (name: string, edited: boolean): string => (edited ? `${name} (edited)` : name);

/** The line above the composer while a switch waits for the reply to end. */
export function switchWaitingLine(name: string, helpers: number, setsModel: boolean): string {
  const moved = [...(setsModel ? ["this chat's model"] : []), `its ${helpers} helper${helpers === 1 ? "" : "s"}`, "alignment settings"];
  const list = moved.length === 3 ? `${moved[0]}, ${moved[1]}, and ${moved[2]}` : `${moved[0]} and ${moved[1]}`;
  return `Switching to ${name} when this reply ends. Moves ${list}. Tools and modes stay.`;
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
 * The limit row's offers (§chat.subagent-profiles/limit-row): up to two of your profiles, in list
 * order, never Off, whose Models part (the chat's own model included) uses no model of the exhausted
 * provider. The chat's current profile only while the chat reads "(edited)". A row with no known
 * providers (no models) promises no provider choice, so it is never offered; neither is a hidden,
 * unusable or unapproved one.
 */
export function limitOffers<T extends SwitchRow>(rows: readonly T[], exhausted: string, current: { key: string | null; edited: boolean }, max = 2): T[] {
  return rows
    .filter((r) => r.group === "yours" && r.kind !== "off" && !r.hidden && !r.unusable && r.approval !== "needed")
    .filter((r) => (r.providers?.length ?? 0) > 0 && !r.providers!.includes(exhausted))
    .filter((r) => r.key !== current.key || current.edited)
    .slice(0, max);
}

/** The picker's rows: Off first, then yours, then this project's; built-in and hidden rows left out
    except Off, which can't be hidden. */
export function pickerRows<T extends SwitchRow>(rows: readonly T[]): T[] {
  const off = rows.filter((r) => r.kind === "off");
  const rest = rows.filter((r) => r.kind !== "off" && !r.hidden);
  return [...off, ...rest.filter((r) => r.group === "yours"), ...rest.filter((r) => r.group === "project")];
}

/** Why a picker row can't be picked here, or null. */
export const rowDisabledReason = (r: SwitchRow): string | null => (r.approval === "needed" ? "Approve it in Settings first" : (r.unusable ?? null));

/** What a picked row does to this chat: nothing (its own profile, not edited), or a switch. */
export const pickDoesSomething = (r: Pick<SwitchRow, "key">, current: { key: string | null; edited: boolean }): boolean => r.key !== current.key || current.edited;

/** The Default button's label. */
export function defaultLabel(state: "idle" | "saving" | "done", name: string | null): string {
  return state === "saving" ? "Saving…" : state === "done" ? "Already the default" : name ? `Make ${name} the Default` : "Make This Profile the Default";
}

/** The Default button's title. */
export function defaultTitle(name: string | null, already: boolean): string {
  if (!name) return "Make this chat's profile the default for new chats.";
  return already ? `New chats already start on ${name}.` : `New chats will start on ${name}.`;
}

/** "New chat in {project}. The default is already picked." */
export const newChatLine = (project: string | null | undefined): string => (project ? `New chat in ${project}. The default is already picked.` : "New chat. The default is already picked.");
