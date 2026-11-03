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
import { compactModel, modelLabel } from "./format";
import { majorGlyph, minorGlyph, type ModeGlyph } from "./mode-glyphs";

/** The Icon a profile's icon names (an unknown one reads as the wrench). */
export function profileIconName(icon: string | undefined): IconName {
  const known: IconName[] = ["grid", "eye", "network", "branch", "wrench", "shield", "search", "terminal", "bulb", "building"];
  return (known as string[]).includes(icon ?? "") ? (icon as IconName) : "wrench";
}

/** Whether a listed profile is Default, the picker's My settings (no profile). */
export const isMySettings = (p: Pick<ListedProfile, "source" | "id">) => p.source === "sova" && p.id === DEFAULT_PROFILE_ID;

/**
 * The picker's groups (§chat.profiles/picker), in its order: My settings (always, never hidden),
 * Yours, This project, then the profiles Sova ships, each without the hidden ones.
 */
export function pickerProfiles(l: ProfilesListing | undefined): { mine: ListedProfile | null; yours: ListedProfile[]; project: ListedProfile[]; projectName: string | null; builtins: ListedProfile[] } {
  if (!l) return { mine: null, yours: [], project: [], projectName: null, builtins: [] };
  const shown = (p: ListedProfile) => !l.hidden.includes(p.key);
  return {
    mine: l.builtins.find(isMySettings) ?? null,
    yours: l.yours.filter(shown),
    project: l.project.profiles.filter(shown),
    projectName: l.project.state === "ok" ? (l.project.name ?? null) : null,
    builtins: l.builtins.filter((p) => !isMySettings(p) && shown(p)),
  };
}

/** The grid's sections in the picker's order, each with its label (none for My settings), empty ones left out. */
export function pickerSections(g: ReturnType<typeof pickerProfiles>): { id: "mine" | "yours" | "project" | "builtins"; label: string | null; cards: ListedProfile[] }[] {
  const all = [
    { id: "mine" as const, label: null, cards: g.mine ? [g.mine] : [] },
    { id: "yours" as const, label: "Yours", cards: g.yours },
    { id: "project" as const, label: `This project (${g.projectName ?? "this folder"})`, cards: g.project },
    { id: "builtins" as const, label: "Built in", cards: g.builtins },
  ];
  return all.filter((s) => s.cards.length > 0);
}

/** The settings My settings stands for: the session's own, now or as remembered (§chat.profiles/picker). */
export interface MySettingsState {
  mode?: string | null;
  minorModes?: readonly string[] | null;
  model?: string | null;
  thinking?: string | null;
}

const capital = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** My settings' caption: "Delegate · Align, Spec · Opus 5.5 · high", each part only when known; "Your own settings" when none is. */
export function mySettingsCaption(s: MySettingsState | null | undefined): string {
  const parts: string[] = [];
  if (s?.mode) parts.push(capital(s.mode));
  if (s?.minorModes?.length) parts.push(s.minorModes.map(capital).join(", "));
  if (s?.model) parts.push(modelLabel(s.model) ?? s.model);
  if (s?.thinking) parts.push(s.thinking);
  return parts.length ? parts.join(" · ") : "Your own settings";
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

/** One row of "What changes vs My settings". */
export interface ChangeRow {
  sign: "+" | "−";
  cap: Removable | Grantable;
  label: string;
  detail: string;
}

/** The rows a profile changes, grants first (§chat.profiles/picker). `present`: the tools My settings has here. */
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

/** The tools My settings (no profile) would have in this runtime: what is active, less the grants, plus what the removals took. */
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

/** How many cards the grid draws: My settings, every shown profile, plus Custom…. */
export const cardCount = (g: ReturnType<typeof pickerProfiles>): number => (g.mine ? 1 : 0) + g.yours.length + g.project.length + g.builtins.length + 1;

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

/** One drawn part of a card's settings caption, each with its complete words for its `title`. */
export type CaptionPart =
  /** The effort ring and the model's short name, each only when the profile sets it. */
  | { kind: "model"; name: string | null; level: string | null; title: string }
  /** The subagents icon and the subagent profile's distinct primary models, or "off". */
  | { kind: "subagents"; text: string; title: string }
  /** A mode's icon, or a project mode's letter. */
  | { kind: "mode"; glyph: ModeGlyph; title: string }
  /** Words where the profile sets something no glyph draws (minor modes set to none). */
  | { kind: "words"; text: string; title: string };

/**
 * A card's caption as drawn (§chat.profiles/picker): `words` for a caption that isn't settings (a
 * description, a disabled reason in the warn tone), or `glyphs`, the parts for what the profile
 * sets, with `label` the whole caption in words (profileCaption / mySettingsCaption) for its
 * accessible name and hover text.
 */
export type CardCaption = { kind: "words"; text: string; tone?: "warn" } | { kind: "glyphs"; label: string; parts: CaptionPart[] };

const modelPart = (model: string | null | undefined, level: string | null | undefined): CaptionPart[] =>
  model || level
    ? [{ kind: "model", name: model ? (compactModel(model) ?? model) : null, level: level ?? null, title: [model ? (modelLabel(model) ?? model) : null, level ? `effort ${level}` : null].filter(Boolean).join(" · ") }]
    : [];

const modePartsOf = (mode: string | null | undefined, minors: readonly string[] | null | undefined): CaptionPart[] => [
  ...(mode ? [{ kind: "mode" as const, glyph: majorGlyph(mode), title: `mode: ${mode}` }] : []),
  ...(minors ?? []).map((m) => ({ kind: "mode" as const, glyph: minorGlyph(m), title: `minor mode: ${m}` })),
];

/**
 * A profile card's caption parts: the model and effort, the subagents count, then the mode icons,
 * each only when the profile sets it; its description when it sets none; `why` (it can't be used
 * here) in the warn tone over either.
 */
export function profileCaptionParts(
  p: Pick<Profile, "model" | "thinking" | "subagents" | "mode" | "minorModes" | "description">,
  subagents: readonly { id: string; footprint: string; models?: number }[] = [],
  why: string | null = null,
): CardCaption {
  if (why) return { kind: "words", text: why, tone: "warn" };
  const parts: CaptionPart[] = [...modelPart(p.model, p.thinking)];
  if (p.subagents) {
    const s = subagents.find((x) => x.id === p.subagents);
    const footprint = p.subagents === "off" ? "off" : (s?.footprint || p.subagents);
    const text = p.subagents === "off" ? "off" : s?.models !== undefined ? String(s.models) : p.subagents;
    parts.push({ kind: "subagents", text, title: `subagents: ${footprint}` });
  }
  parts.push(...modePartsOf(p.mode, p.minorModes));
  if (p.minorModes && !p.minorModes.length) parts.push({ kind: "words", text: "no minor modes", title: "no minor modes" });
  if (!parts.length) return { kind: "words", text: p.description };
  return { kind: "glyphs", label: profileCaption(p, subagents), parts };
}

/** My settings' caption parts, in its own order: the mode icons first, then the model and effort. */
export function mySettingsCaptionParts(s: MySettingsState | null | undefined): CardCaption {
  const parts = [...modePartsOf(s?.mode, s?.minorModes), ...modelPart(s?.model, s?.thinking)];
  const label = mySettingsCaption(s);
  return parts.length ? { kind: "glyphs", label, parts } : { kind: "words", text: label };
}

/**
 * The picked profile's settings in full words (§chat.profiles/picker), the first line of its
 * details: "Model: Opus 5.5 · Effort: high · Subagents: Claude subs (Opus 5.5, glm-5.3) · Main mode:
 * delegate · Add-on modes: align, spec", what it leaves unset left out; null when it sets none.
 */
export function profileSettingsLine(
  p: Pick<Profile, "model" | "thinking" | "subagents" | "mode" | "minorModes">,
  subagents: readonly { id: string; name: string; footprint: string }[] = [],
): string | null {
  const parts: string[] = [];
  if (p.model) parts.push(`Model: ${modelLabel(p.model) ?? p.model}`);
  if (p.thinking) parts.push(`Effort: ${p.thinking}`);
  if (p.subagents) {
    const s = subagents.find((x) => x.id === p.subagents);
    parts.push(`Subagents: ${p.subagents === "off" ? "off" : s ? `${s.name} (${s.footprint.split(" · ").join(", ")})` : p.subagents}`);
  }
  if (p.mode) parts.push(`Main mode: ${p.mode}`);
  if (p.minorModes) parts.push(`Add-on modes: ${p.minorModes.length ? p.minorModes.join(", ") : "none"}`);
  return parts.length ? parts.join(" · ") : null;
}

/** Why a card can't be picked on this host now (the listing's sentence), or null. */
export const cardUnusable = (l: ProfilesListing | undefined, p: Pick<ListedProfile, "key">): string | null => l?.unusable?.[p.key] ?? null;
