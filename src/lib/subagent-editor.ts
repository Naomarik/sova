import type { SubagentProfile, TeamsSetting } from "../../shared/subagent-profiles";
import type { TeamDefaults } from "../../shared/team-defaults";
import { profilesProblem } from "./subagent-profiles-draft";
import { claudeModelName } from "./format";

/**
 * Settings → Subagents' editor, the parts that are rules rather than markup: each collapsible
 * section's one-line summary, which sections hold something Save waits for, and how Choose Models
 * and Use Default Model map onto the stored `teams` shape.
 */

export type EditorSection = "delegate" | "teams" | "spec" | "reviewer" | "alignment";

/**
 * A model's shortest readable form, the footprint's own rule (`shortModel` in
 * pi-config/extensions/subagents/subagent-profiles.ts, which the browser can't import), so a
 * summary and the list's footprint name a model alike: a Claude model by its catalog name
 * (`opus[1m]` → Opus 5.5), else the id without its provider (`zai/glm-5.3` → glm-5.3).
 */
export function footprintModel(model: string): string {
  const name = claudeModelName(model);
  if (name) return name;
  return model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
}
const model = (m: string): string | null => (m ? footprintModel(m) : null);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Delegate routing, closed: the routes' distinct primary models, then how many fallbacks. */
export function delegateSummary(p: SubagentProfile): string {
  const routes = Object.values(p.delegate);
  const names: string[] = [];
  for (const r of routes) {
    const m = model(r.primary.model);
    if (m && !names.includes(m)) names.push(m);
  }
  const fallbacks = routes.filter((r) => r.fallback !== null).length;
  return [names.length ? names.join(" · ") : "No models chosen", fallbacks ? plural(fallbacks, "fallback") : "no fallbacks"].join(" · ");
}

/**
 * Teams, closed: the standing roles' models, then the members default. Every team gets both roles;
 * `teams: null` runs them on the chat's own model.
 */
export function teamsSummary(p: SubagentProfile): string {
  const t = p.teams;
  const pending = "a model not chosen yet";
  const roles = t
    ? `Coordinator on ${model(t.coordinator.primary.model) ?? pending} · monitor on ${model(t.monitor.primary.model) ?? pending}`
    : "Coordinator + monitor on the default model";
  const members = p.members ? `members on ${model(p.members.model) ?? pending}` : "members on the lead's model";
  return `${roles} · ${members}`;
}

/** Spec writer, closed: the writer's model, or who writes the spec without one. */
export function specSummary(p: SubagentProfile): string {
  if (!p.specWriter) return "Off · the session writes it";
  const m = model(p.specWriter.primary.model) ?? "No model chosen";
  return p.specWriter.fallback ? `${m} · 1 fallback` : m;
}

/** The align mode's writing style labels (pi-config/extensions/mode/align-settings.ts ALIGN_STYLE_LABELS). */
export const ALIGN_STYLE_NAMES = { pm: "Project manager", simplified: "Simplified", default: "Technical" } as const;
/** The align mode's Eagerness labels, in their order (align-settings.ts ALIGN_EAGERNESS_LABELS). */
export const ALIGN_EAGERNESS_NAMES = { eager: "Eager", careful: "Careful" } as const;
type AlignOverride = NonNullable<SubagentProfile["alignment"]>;

/** Alignment, closed (§chat.subagent-profiles/settings): "Host default", or what the profile overrides. */
export function alignmentSummary(p: SubagentProfile): string {
  const a = p.alignment;
  const parts = [
    a?.eagerness ? ALIGN_EAGERNESS_NAMES[a.eagerness] : undefined,
    a?.style ? ALIGN_STYLE_NAMES[a.style] : undefined,
    a?.visuals === undefined ? undefined : a.visuals ? "visuals on" : "visuals off",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "Host default";
}

/**
 * The profile's override after one choice: "host" stores no field, and all three on "host" store no
 * `alignment` at all, so a profile with no override is written exactly as before the field existed.
 */
export function withAlignment(
  p: SubagentProfile,
  patch: { eagerness?: AlignOverride["eagerness"] | "host"; style?: AlignOverride["style"] | "host"; visuals?: boolean | "host" },
): SubagentProfile {
  const next: AlignOverride = { ...(p.alignment ?? {}) };
  if (patch.eagerness !== undefined) {
    if (patch.eagerness === "host") delete next.eagerness;
    else next.eagerness = patch.eagerness;
  }
  if (patch.style !== undefined) {
    if (patch.style === "host") delete next.style;
    else next.style = patch.style;
  }
  if (patch.visuals !== undefined) {
    if (patch.visuals === "host") delete next.visuals;
    else next.visuals = patch.visuals;
  }
  const out: SubagentProfile = { ...p };
  if (next.eagerness === undefined && next.style === undefined && next.visuals === undefined) delete out.alignment;
  else out.alignment = next;
  return out;
}

/** Reviewer, closed: the reviewer's model, or that nothing reviews. */
export function reviewerSummary(p: SubagentProfile): string {
  if (!p.reviewer) return "Off · no review";
  const m = model(p.reviewer.primary.model) ?? "No model chosen";
  return p.reviewer.fallback ? `${m} · 1 fallback` : m;
}

/** What Choose Models gives both roles: the profile's saved roles, else the legacy team defaults (`null` while neither is known). */
export function teamsSeed(saved: TeamsSetting | null | undefined, legacy: TeamDefaults | null | undefined): TeamsSetting | null {
  if (saved) return JSON.parse(JSON.stringify(saved)) as TeamsSetting;
  if (!legacy) return null;
  // The legacy defaults were born of the same store's parse, so the wire type's wide `string`
  // effort is really the tuple's union; the next save's parse rechecks it.
  return JSON.parse(JSON.stringify({ coordinator: legacy.coordinator, monitor: legacy.monitor, handover: legacy.handover })) as TeamsSetting;
}

/** Choose Models: both roles get their worker rows from `seed`. A profile that has them keeps them. */
export function withChosenModels(p: SubagentProfile, seed: TeamsSetting | null): SubagentProfile {
  const next: SubagentProfile = JSON.parse(JSON.stringify(p));
  if (!next.teams && seed) next.teams = JSON.parse(JSON.stringify(seed)) as TeamsSetting;
  return next;
}

/** Use Default Model: both roles back on the chat's own model, with Sova's built-in values. */
export function withDefaultModel(p: SubagentProfile): SubagentProfile {
  return { ...JSON.parse(JSON.stringify(p)), teams: null };
}

/** A copy of `p` with only `section` kept as it is; every other section is made trivially valid. */
function only(p: SubagentProfile, section: EditorSection): SubagentProfile {
  const x: SubagentProfile = JSON.parse(JSON.stringify(p));
  const ok = { backend: "pi" as const, model: "a/b", effort: "low" };
  if (section !== "delegate") for (const k of Object.keys(x.delegate) as (keyof SubagentProfile["delegate"])[]) x.delegate[k] = { primary: ok, fallback: null };
  if (section !== "teams") {
    x.teams = null;
    x.members = null;
  }
  if (section !== "spec") x.specWriter = null;
  if (section !== "reviewer") delete x.reviewer;
  if (section !== "alignment") delete x.alignment;
  x.name = "x";
  return x;
}

/**
 * The editor's sections that hold something Save waits for, by the same rule the footer says it
 * (`profilesProblem`), so a section never opens itself for a reason Save doesn't have.
 */
export function sectionProblems(p: SubagentProfile): Set<EditorSection> {
  const out = new Set<EditorSection>();
  for (const s of ["delegate", "teams", "spec", "reviewer", "alignment"] as const) if (profilesProblem({ version: 1, default: "off", profiles: [only(p, s)] })) out.add(s);
  return out;
}
