import { assistantWouldAct, type AssistantAbility, type WouldAnswer } from "./assistant-would-act";

/**
 * What the Project Assistant offers at each reply (§app.project-assistant/offers): its prompt's lines for a fix, a
 * planning chat, a release and a version, its tool list and two tools' descriptions, all from the question Home's card
 * asks (assistantWouldAct, §app.project-assistant/abilities) for each shown project. An ability is offered only where
 * it answers `now` or `held`; one offered nowhere is never mentioned. Opening a running or starting version is always
 * offered. A change between replies gets one hidden note (offersNote).
 */

export interface ProjectOffer {
  id: string;
  name: string;
  /** Each ability's answer now. */
  fix: WouldAnswer;
  version: WouldAnswer;
  release: WouldAnswer;
  feature: WouldAnswer;
}
export interface AssistantOffers {
  projects: ProjectOffer[];
}

/** What a note and a change are told by: each ability the assistant may set off itself, and where. */
type Offered = "fix" | "feature" | "versionStart" | "release";
const OFFERED: Record<Offered, AssistantAbility> = { fix: "fix", feature: "feature", versionStart: "version", release: "release" };
const LABEL: Record<Offered, string> = {
  fix: "starting a fix",
  feature: "opening a planning chat",
  versionStart: "starting a version that isn't running",
  release: "starting a release on its own",
};

const acts = (a: WouldAnswer) => a.outcome === "now" || a.outcome === "held";

/** The answers for every shown project; an answer that can't be had reads as the team (nothing offered). */
export async function assistantOffers(projects: readonly { id: string; name: string }[], orgId: string): Promise<AssistantOffers> {
  const ask = (pid: string, a: AssistantAbility) => assistantWouldAct(orgId, pid, a).catch((): WouldAnswer => ({ outcome: "team", reason: "unreadable" }));
  const rows = await Promise.all(
    projects.map(async (p) => {
      const [fix, version, release, feature] = await Promise.all((["fix", "version", "release", "feature"] as const).map((a) => ask(p.id, a)));
      return { id: p.id, name: p.name, fix: fix!, version: version!, release: release!, feature: feature! };
    }),
  );
  return { projects: rows };
}

/** The shown projects where `what` would be set off (now or held). */
export function offeredIn(o: AssistantOffers, what: Offered): ProjectOffer[] {
  return o.projects.filter((p) => acts(p[OFFERED[what]]));
}

const names = (ps: readonly { name: string }[]): string => {
  const n = ps.map((p) => p.name);
  return n.length <= 1 ? (n[0] ?? "") : `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;
};
/** " in A and B" when only some shown projects are, else "". */
const scope = (o: AssistantOffers, ps: readonly ProjectOffer[], word = "in"): string => (ps.length && ps.length < o.projects.length ? ` ${word} ${names(ps)}` : "");

/** The release, per project: on its own (now/held), asking the team, or no release steps (the team only files it). */
function releaseGroups(o: AssistantOffers) {
  const self = o.projects.filter((p) => acts(p.release));
  const noSteps = o.projects.filter((p) => !acts(p.release) && p.release.reason === "no-recipe");
  const team = o.projects.filter((p) => !acts(p.release) && p.release.reason !== "no-recipe");
  return { self, team, noSteps };
}

/** The prompt's lines, each a whole "- …" line or "" (hidden completely). `{{OWNER}}` is filled after. */
export function offerLines(o: AssistantOffers): { fix: string; planning: string; requirements: string; release: string; versions: string } {
  const fixIn = offeredIn(o, "fix");
  const fix = fixIn.length
    ? `- When a problem${scope(o, fixIn)} needs fixing, offer to start a fix with \`start_fix\` and tell {{OWNER}} what its answer says (started, starting in a few minutes, or with the team).${scope(o, fixIn) ? " For any other project, the problem you filed is with the team, and the team fixes it." : ""}`
    : "";
  const planIn = offeredIn(o, "feature");
  const planning = planIn.length
    ? `- When {{OWNER}} asks for something new${scope(o, planIn)} that needs planning (a new screen, a new way of working), offer to plan it with them in a planning chat of its own: agree a short title, then call \`start_feature_chat\` and say what its answer says (it is open, with a button under your message; or it went to the team; or they already have one open, or one can't be opened yet, and you offer to send it to the team instead). Never describe how the planning chat works inside.`
    : "";
  const requirements = `- When {{OWNER}} asks for something new or a change to how something works${planIn.length ? " and no planning chat is opened for it" : ""}, it is a requirement: work out what they want in plain words, note each one with \`requirement_agree\`, and before the conversation moves on, repeat everything agreed back to them (\`requirements_summary\`) in their own terms. Only after a clear yes, call \`requirements_confirm\`; then file it with the team with \`report_issue\` (kind \`feature\`). Until they say yes, it is not confirmed.`;

  const g = releaseGroups(o);
  const parts: string[] = [];
  const many = [g.self, g.team, g.noSteps].filter((x) => x.length).length > 1;
  const lead = (ps: ProjectOffer[]) => (many ? `For ${names(ps)}, ` : "");
  if (g.self.length) parts.push(`${lead(g.self)}it starts the release itself (right away or in a few minutes).`);
  if (g.team.length) parts.push(`${lead(g.team)}it asks the team to release it: say it's with the team.`);
  if (g.noSteps.length) parts.push(`${lead(g.noSteps)}it sends the request to the team: say it's with the team, and never that it is released or that the team will release it.`);
  const release = o.projects.length ? `- When they ask for a release, use \`deploy\` and say what its answer says. ${parts.join(" ").replace(/^it/, "It")}` : "";

  const startIn = offeredIn(o, "versionStart");
  const start = startIn.length
    ? scope(o, startIn)
      ? ` For ${names(startIn)}, you can also offer to start one that isn't running with \`start_version\`: tell them what its answer says (starting, with the team, or that it didn't start and the team knows). For any other project, \`start_version\` sends a request to start one to the team: tell them it's with the team.`
      : " To try one that isn't running, offer to start it with `start_version` and tell them what its answer says: starting (its Open button is in this chat and on their home page), with the team, or that it didn't start and the team knows."
    : " A version that isn't running isn't started from here: if they want one, `start_version` sends the request to the team; tell them it's with the team.";
  const versions = `- When {{OWNER}} wants to see or try something (a fix, how the app looks now), \`owner_versions\` lists each project's versions and whether each is running; never say one exists or runs unless it lists it. One that is running or starting can always be opened: call \`start_version\` with its label (as \`owner_versions\` gives it), and its Open button shows in this chat and on their home page.${start} Never write a link or an address yourself, never name a port or a branch, and never promise when it will be ready. A version keeps running until the team stops it.`;
  return { fix, planning, requirements, release, versions };
}

/** The two served tools whose words follow the offers (their declarations are registered again on a change). */
export interface ToolWords {
  /** Some shown project would release on its own. */
  releaseSelf: boolean;
  /** Some shown project would start a version that isn't running. */
  versionStart: boolean;
}
export const toolWordsOf = (o: AssistantOffers): ToolWords => ({ releaseSelf: offeredIn(o, "release").length > 0, versionStart: offeredIn(o, "versionStart").length > 0 });

/** The tools hidden from this reply: a fix and a planning chat offered nowhere. */
export function hiddenTools(o: AssistantOffers): string[] {
  return [...(offeredIn(o, "fix").length ? [] : ["start_fix"]), ...(offeredIn(o, "feature").length ? [] : ["start_feature_chat"])];
}

/** What a change is told by: "ability project-id" for each ability offered for each project. */
export function offeredKeys(o: AssistantOffers): string[] {
  const out: string[] = [];
  for (const w of Object.keys(OFFERED) as Offered[]) for (const p of offeredIn(o, w)) out.push(`${w} ${p.id}`);
  return out.sort();
}

/** The hidden note for a change between two replies, or null when nothing changed. `before`: offeredKeys of the last
    offers this server worked out for the chat. */
export function offersNote(before: readonly string[], now: AssistantOffers, owner: string): string | null {
  const after = offeredKeys(now);
  const was = new Set(before);
  const is = new Set(after);
  const nameOf = new Map(now.projects.map((p) => [p.id, p.name]));
  const describe = (keys: string[]): string[] => {
    const by = new Map<Offered, string[]>();
    for (const k of keys) {
      const [w, pid] = k.split(" ") as [Offered, string];
      by.set(w, [...(by.get(w) ?? []), pid]);
    }
    return [...by].map(([w, pids]) => {
      const ps = pids.map((id) => nameOf.get(id)).filter((n): n is string => !!n);
      return `${LABEL[w]}${now.projects.length > 1 && ps.length ? ` (${names(ps.map((name) => ({ name })))})` : ""}`;
    });
  };
  const on = describe(after.filter((k) => !was.has(k)));
  const off = describe(before.filter((k) => !is.has(k)));
  if (!on.length && !off.length) return null;
  return [
    "What you can set off has changed since your last reply; your instructions above are as it is now.",
    on.length ? `Now offered: ${on.join("; ")}.` : "",
    off.length ? `No longer offered: ${off.join("; ")}. Don't follow up an earlier offer of ${off.length > 1 ? "any of these" : "it"}; if ${owner} takes one up, do what your instructions say now, plainly, without calling it a change.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}
