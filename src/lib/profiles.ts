import type { IconName } from "../components/ui";
import {
  CAPABILITY_LABEL,
  CAPABILITY_TOOLS,
  DEFAULT_PROFILE_ID,
  GRANTABLE,
  limitsLine,
  REMOVABLE,
  toolRemoved,
  type Grantable,
  type ListedProfile,
  type Profile,
  type ProfilesListing,
  type Removable,
} from "../../shared/profiles";
import type { ChatProfileInfo } from "../../shared/protocol";
import { modelLabel } from "./format";

/** The Icon a profile's icon names (an unknown one reads as the wrench). */
export function profileIconName(icon: string | undefined): IconName {
  const known: IconName[] = ["grid", "eye", "network", "branch", "wrench", "shield", "search", "terminal", "bulb", "building"];
  return (known as string[]).includes(icon ?? "") ? (icon as IconName) : "wrench";
}

/** The pickers' groups (§chat.profiles/picker): Built in (Default always), This project, Yours, each without the hidden ones. */
export function pickerProfiles(l: ProfilesListing | undefined): { builtins: ListedProfile[]; project: ListedProfile[]; projectName: string | null; yours: ListedProfile[] } {
  if (!l) return { builtins: [], project: [], projectName: null, yours: [] };
  const shown = (p: ListedProfile) => (p.source === "sova" && p.id === DEFAULT_PROFILE_ID) || !l.hidden.includes(p.key);
  return {
    builtins: l.builtins.filter(shown),
    project: l.project.profiles.filter(shown),
    projectName: l.project.state === "ok" ? (l.project.name ?? null) : null,
    yours: l.yours.filter(shown),
  };
}

/** Every profile the listing has, in the pickers' order, hidden ones included. */
export const allProfiles = (l: ProfilesListing | undefined): ListedProfile[] => (l ? [...l.builtins, ...l.project.profiles, ...l.yours] : []);

/** What a pick sends for a listed profile. */
export const pickRef = (p: Pick<ListedProfile, "source" | "id">) => ({ source: p.source, id: p.id });

/** "reads and messages sessions · no edit files · One at a time · delegate · align, spec": a profile's summary line (Settings → Profiles). */
export function profileSummary(p: Pick<Profile, "remove" | "grant" | "singleton" | "mode" | "minorModes">): string {
  const parts: string[] = [];
  const g = new Set(p.grant);
  if (g.has("sessions.message")) parts.push(g.has("sessions.all") ? "sees and messages all sessions" : "reads and messages sessions");
  else if (g.has("sessions.read")) parts.push(g.has("sessions.all") ? "reads all sessions" : "reads sessions");
  const off = p.remove.filter((r) => r !== "workers" || p.remove.length === 1);
  if (off.length) parts.push(`no ${off.map((r) => CAPABILITY_LABEL[r].toLowerCase()).join(", ")}`);
  if (p.singleton) parts.push("One at a time");
  parts.push(...modeParts(p));
  return parts.length ? parts.join(" · ") : "Nothing changed";
}

/** A profile's mode and minor modes as line parts, each only when it sets it: "delegate", "align, spec, vis" or "no minor modes". */
function modeParts(p: Pick<Profile, "mode" | "minorModes">): string[] {
  return [...(p.mode ? [p.mode] : []), ...(p.minorModes ? [p.minorModes.length ? p.minorModes.join(", ") : "no minor modes"] : [])];
}

/** One row of "What changes vs Default". */
export interface ChangeRow {
  sign: "+" | "−";
  cap: Removable | Grantable;
  label: string;
  detail: string;
}

/** The rows a profile changes, grants first (§chat.profiles/picker). `present`: the tools Default has here. */
export function changeRows(p: Pick<Profile, "remove" | "grant" | "limits">, present: readonly string[]): ChangeRow[] {
  const rows: ChangeRow[] = [];
  for (const g of GRANTABLE)
    if (p.grant.includes(g))
      rows.push({
        sign: "+",
        cap: g,
        label: CAPABILITY_LABEL[g],
        detail:
          g === "sessions.read"
            ? "Marked untrusted when read"
            : g === "sessions.message"
              ? `${limitsLine(p.limits)}. Its messages arrive tagged with this session's title.`
              : "Every session Sova lists on this host",
      });
  for (const r of REMOVABLE)
    if (p.remove.includes(r)) {
      const names = present.filter((t) => toolRemoved(t, [r]));
      const shown = names.length ? names : CAPABILITY_TOOLS[r].map((t) => t.replace("*", "…"));
      rows.push({ sign: "−", cap: r, label: CAPABILITY_LABEL[r], detail: shown.length > 3 ? `${shown.slice(0, 2).join(", ")}, ${shown.length - 2} more` : shown.join(", ") });
    }
  return rows;
}

/** The tools Default would have in this runtime: what is active, less the grants, plus what the removals took. */
export function defaultTools(info: Pick<ChatProfileInfo, "tools" | "granted" | "removed">): string[] {
  return [...info.tools.filter((t) => !info.granted.includes(t)), ...info.removed].sort();
}

/** The guardrail note, or null when nothing is removed (§chat.profiles/picker). */
export function guardrailNote(remove: readonly string[]): string | null {
  if (!remove.length) return null;
  return remove.includes("shell")
    ? "The shell is off, so these removals hold."
    : "The shell is on, so removals are guardrails, not a boundary. Bash can still change files and call Sova's API.";
}

/** The grid shows a Find a profile field past this many cards (Custom… included). */
export const CARD_FILTER_AFTER = 9;

/** How many cards the grid draws: every shown profile, plus Custom…. */
export const cardCount = (g: ReturnType<typeof pickerProfiles>): number => g.builtins.length + g.project.length + g.yours.length + 1;

/** Whether a profile matches the Find a profile field (by name, ignoring case; an empty query matches all). */
export const cardMatches = (p: Pick<Profile, "label">, query: string): boolean => !query.trim() || p.label.toLowerCase().includes(query.trim().toLowerCase());

/**
 * A card's one caption line: what it sets of "{model} · {effort} · subagents: {footprint} · {mode} ·
 * {minor modes}", or its description when it sets none. `subagents`: this device's subagent profiles
 * (the listing's), for the footprint; "off" reads "off", and an id this device lacks reads as the id.
 */
export function profileCaption(p: Pick<Profile, "model" | "thinking" | "subagents" | "mode" | "minorModes" | "description">, subagents: readonly { id: string; footprint: string }[] = []): string {
  const parts: string[] = [];
  if (p.model) parts.push(modelLabel(p.model) ?? p.model);
  if (p.thinking) parts.push(p.thinking);
  if (p.subagents) parts.push(`subagents: ${p.subagents === "off" ? "off" : (subagents.find((s) => s.id === p.subagents)?.footprint || p.subagents)}`);
  parts.push(...modeParts(p));
  return parts.length ? parts.join(" · ") : p.description;
}

/** Why a card can't be picked on this host now (the listing's sentence), or null. */
export const cardUnusable = (l: ProfilesListing | undefined, p: Pick<ListedProfile, "key">): string | null => l?.unusable?.[p.key] ?? null;
