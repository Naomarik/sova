// What the Project Assistant can do for the owner (§app.project-assistant/abilities), in the owner
// page's words (§design.copy-deck/owner-page): the card's lines, the chat's suggestions and what a tap
// starts in the message box. Pure: the share build and the operator's preview both render through
// it. Imports types only, but for the request status helper.
import type { OwnerAbilities, OwnerAbilityOutcome } from "../../shared/owner";
import type { OwnerRequestRow } from "../../shared/project-assistant";

export type AbilityId = "ask" | "report" | "new" | "plan" | "fix" | "try" | "release";

export interface AbilityLine {
  id: AbilityId;
  /** The plain name ("Get a problem fixed"): the chat's suggestion. */
  name: string;
  /** How it happens: one plain sentence when every project agrees; else the projects of each answer,
      lower case after the name and a colon ("on its own for A, the team starts it for B."). */
  how: string;
  /** The projects differ: the line reads "{name}: {how}". */
  named: boolean;
  /** What a tap starts in the message box. */
  prefill: string;
}

/** "A", "A and B", "A, B and C". */
export function nameList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

type Kind = "fix" | "version" | "release";
const NAME: Record<Kind, string> = { fix: "Get a problem fixed", version: "Try the latest version", release: "Release a new version" };
/** One plain sentence per answer, when every project the line covers gives it. */
const PLAIN: Record<Kind, Record<OwnerAbilityOutcome, string>> = {
  fix: { now: "Starts right away", held: "Starts on its own in a few minutes", team: "The team decides when to start it" },
  // A version is never held; a held answer reads as right away.
  version: { now: "Starts right away, with an Open button", held: "Starts right away, with an Open button", team: "The team starts it for you" },
  release: { now: "Starts right away", held: "Starts on its own in a few minutes", team: "The team releases it" },
};
/** The segment of each answer when projects differ, in this order. */
const ORDER: readonly OwnerAbilityOutcome[] = ["now", "held", "team"];
const SEGMENT: Record<Kind, Record<OwnerAbilityOutcome, (projects: string) => string>> = {
  fix: { now: (p) => `right away for ${p}`, held: (p) => `on its own for ${p}`, team: (p) => `the team starts it for ${p}` },
  version: { now: (p) => `right away for ${p}`, held: (p) => `right away for ${p}`, team: (p) => `the team starts it for ${p}` },
  release: { now: (p) => `right away for ${p}`, held: (p) => `on its own for ${p}`, team: (p) => `the team releases it for ${p}` },
};

/** The "how" of one line over the projects it covers (each name with its answer, in Home's order). */
export function howLine(kind: Kind, rows: readonly { name: string; outcome: OwnerAbilityOutcome }[]): { how: string; named: boolean } {
  // A version's held reads as now: group them so one answer stays one plain line.
  const norm = (o: OwnerAbilityOutcome): OwnerAbilityOutcome => (kind === "version" && o === "held" ? "now" : o);
  const answers = new Set(rows.map((r) => norm(r.outcome)));
  if (answers.size <= 1) return { how: PLAIN[kind][norm(rows[0]?.outcome ?? "team")], named: false };
  const parts = ORDER.flatMap((o) => {
    const names = rows.filter((r) => norm(r.outcome) === o).map((r) => r.name);
    return names.length ? [SEGMENT[kind][o](nameList(names))] : [];
  });
  return { how: `${parts.join(", ")}.`, named: true };
}

/** The card's lines, in order: up to 6. `abilities` absent (an older answer): the three that never
    depend on a switch. */
export function abilityLines(projects: readonly { id: string; name: string }[], abilities: OwnerAbilities | undefined): AbilityLine[] {
  const shown = (abilities?.projects ?? []).flatMap((a) => {
    const p = projects.find((x) => x.id === a.project);
    return p ? [{ ...a, name: p.name }] : [];
  });
  const one = projects.length === 1 ? projects[0]!.name : null;
  const lines: AbilityLine[] = [
    { id: "ask", name: "Ask about your projects", how: "Answers right away", named: false, prefill: one ? `How is ${one} going?` : "How are my projects going?" },
    { id: "report", name: "Report a problem", how: "Goes to the team at once", named: false, prefill: "Something isn't working: " },
    { id: "new", name: "Ask for something new", how: "Written up with you, then sent to the team", named: false, prefill: "I'd like something new: " },
  ];
  if (!abilities || !shown.length) return lines;
  // Plan something new with you (§app.project-assistant/feature-chats): in place of "Ask for something new" while
  // some project opens a feature request chat; while none does, the line above stays as it always was.
  const plans = shown.map((s) => ({ name: s.name, now: s.feature === "now" }));
  if (plans.some((p) => p.now)) {
    const all = plans.every((p) => p.now);
    const how = all
      ? { how: "Opens a chat with you right away", named: false }
      : { how: `right away for ${nameList(plans.filter((p) => p.now).map((p) => p.name))}, the team plans it for ${nameList(plans.filter((p) => !p.now).map((p) => p.name))}.`, named: true };
    lines[2] = { id: "plan", name: "Plan something new with you", ...how, prefill: "I'd like to plan something new: " };
  }
  lines.push({ id: "fix", name: NAME.fix, ...howLine("fix", shown.map((s) => ({ name: s.name, outcome: s.fix }))), prefill: "Please fix this: " });
  const withVersion = shown.flatMap((s) => (s.version === "none" ? [] : [{ name: s.name, outcome: s.version }]));
  if (withVersion.length) lines.push({ id: "try", name: NAME.version, ...howLine("version", withVersion), prefill: `Can I try the latest version of ${withVersion[0]!.name}?` });
  const single = shown.length === 1 ? shown[0]!.name : null;
  lines.push({
    id: "release",
    name: NAME.release,
    ...howLine("release", shown.map((s) => ({ name: s.name, outcome: s.release }))),
    prefill: single ? `Please release a new version of ${single}.` : "Please release a new version of ",
  });
  return lines;
}

/** The line as one sentence (its accessible text): "Get a problem fixed: on its own for A, …". */
export const lineText = (l: AbilityLine): string => (l.named ? `${l.name}: ${l.how}` : `${l.name}. ${l.how}.`);

/** The photos note under the list. */
export const PHOTOS_NOTE = "You can add photos and screenshots.";

/** An open request: with the team or being worked on. */
const isOpen = (r: Pick<OwnerRequestRow, "status">): boolean => r.status === "with-team" || r.status === "started";
/** The Requests tab's badge: the open requests. */
export const openCount = (rs: readonly Pick<OwnerRequestRow, "status">[] | undefined): number => (rs ?? []).filter(isOpen).length;
/** Home's line on the owner's requests: "Your requests: 1 with the team ›", or "Your requests: 3 ›". A feature
    request being planned with the owner reads Planning with you, so it is not with the team. */
export function requestsLine(rs: readonly Pick<OwnerRequestRow, "status" | "plan">[]): string {
  const team = rs.filter((r) => r.status === "with-team" && r.plan !== "planning").length;
  return team ? `Your requests: ${team} with the team ›` : `Your requests: ${rs.length} ›`;
}
