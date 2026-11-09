/**
 * The Overseers' view of this computer's profiles (§chat.subagent-profiles/overseer): one row per profile of the
 * joined list (§chat.profiles/joined), as `GET /api/profiles` answers it, and the line each tool prints. Pure.
 */

/** A row of the joined list, as much of it as the Overseers read. */
export interface JoinedRow {
  /** What a call's `profile` takes: "off", a pair's (or unlinked session profile's) session id, or a library id. */
  id: string;
  key?: string;
  /** "library": a library profile no session profile links to, so it has only a Models part. */
  kind: string;
  group?: string;
  name: string;
  footprint: string;
  /** The library half it links (what `subagent_profile` takes), or a library-only row's own id. */
  libraryId?: string;
  session?: { overseerMayStart?: boolean; source?: string };
  isDefault?: true;
  approval?: "needed" | "approved";
  unusable?: string;
  linkMissing?: string;
}

/** Whether a row is only a Models part (a library-only profile, or Off): starting it needs no Overseer mark. */
export const modelsOnly = (r: Pick<JoinedRow, "kind">): boolean => r.kind === "library" || r.kind === "off";

/** One line of sova_list_profiles: id, name, footprint, its parts, whether the Overseer may start it, the default. */
export function profileLine(r: JoinedRow): string {
  const parts = r.kind === "off" ? "sets nothing" : modelsOnly(r) ? "Models part only" : r.libraryId ? "When a Chat Starts + Models" : "When a Chat Starts + this chat's model (helpers: the default's)";
  const start = modelsOnly(r) ? "needs no mark" : r.session?.overseerMayStart ? 'marked "The Overseer may start it"' : 'not marked "The Overseer may start it"';
  const bits = [
    `${r.id}: ${r.name}`,
    r.footprint,
    parts,
    ...(r.libraryId && r.libraryId !== r.id ? [`subagent_profile ${r.libraryId}`] : []),
    start,
    ...(r.approval === "needed" ? ["needs the user's approval"] : []),
    ...(r.unusable ? [`can't be used: ${r.unusable}`] : r.linkMissing ? [`helpers missing: ${r.linkMissing}`] : []),
    ...(r.isDefault ? ["default"] : []),
  ];
  return bits.join(" · ");
}

/** The tools' sentence for an id the list lacks. */
export const unknownProfile = (id: string) => `Unknown profile: ${id}. sova_list_profiles lists them.`;

/** What sova_set_session says a profile switch did, from `POST /api/sessions/profile-switch`'s answer. */
export function profileSwitchWords(r: { applies?: string; state?: { current?: { name?: string; model?: string | null }; pending?: { name?: string } } } | null | undefined): string {
  const now = r?.state?.current;
  if (r?.applies === "after-turn") return `profile ${r.state?.pending?.name ?? now?.name ?? "?"} when its reply ends (its model and helpers together; tools and modes stay)`;
  return `profile ${now?.name ?? "?"}${now?.model ? `, model ${now.model}` : ""} (its whole Models part; tools and modes stay)`;
}
