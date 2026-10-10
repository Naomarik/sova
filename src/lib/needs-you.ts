// The sidebar's "Needs you" region: the sessions the attention digest puts in its act tier
// (server/attention.ts — a dialog open, an errored turn, a subagent error, open alignment questions
// waiting on you, a baton hand-off), said once more above Recent. A reply that asks, a team gone
// quiet and a branch ready to merge are decide items: quiet marks on their rows, never listed here.
//
// One decide-tier kind lists too: a roster proposal (§app.organizations/referrals) waits on the
// operator's Approve or Decline and on nothing else, so it is a thing to act on here.
//
// Like Recent it is a SHORTCUT: every session it lists keeps its row wherever it lives. The digest,
// not the session list, is the source, because two act kinds (a hosted pending dialog, a worker
// error) and every detail sentence reach only the digest.
//
// Pure on purpose, like `recent` and `group-open`: the rules run under tsx --test, and the sidebar
// keeps the (sessionStorage) state.

import type { AttentionDigest, AttentionItem, OverseerProactivity, SessionSummary } from "../../shared/protocol";

/** Open by default; a collapse is remembered for the tab, like the Archive's `sova:archive-open`. */
export const NEEDS_YOU_KEY = "sova:needs-you-open";

/** One session in the region: its row, and the digest's sentence that replaces the row's line 2. */
export interface NeedsYouRow {
  session: SessionSummary;
  /** The newest act item's detail ("2 open questions in al_3 …", "Waiting on a dialog."); null when it has none. */
  detail: string | null;
  /** Every act item's detail for this session, newest first, for the line's tooltip. */
  details: string[];
  /** ms epoch of the session's newest act item; 0 unknown. */
  since: number;
  /** A proposed verb playbook run's item (`playbook-review`): what the row's Merge Branch needs
      (§app.project-runtime/review), the one button a Needs you row carries. */
  playbook?: NonNullable<AttentionItem["playbook"]>;
}

/** Whether a digest item lists in the region: every act item, and a roster proposal. */
export const listsInNeedsYou = (it: Pick<AttentionItem, "tier" | "kind">): boolean => it.tier === "act" || it.kind === "roster-proposal";

/**
 * The region's rows: one per session with at least one act item (or roster proposal), newest first by that session's
 * newest act item, joined by path to `sessions` — the sidebar's hit list, so a search or the host
 * filter narrows this region like every other and it never lists a row the rest of the pane hides.
 * A digest session the list doesn't carry is dropped: the count is the rows.
 */
export function needsYouRows(digest: Pick<AttentionDigest, "items"> | undefined, sessions: readonly SessionSummary[]): NeedsYouRow[] {
  if (!digest) return [];
  const byPath = new Map(sessions.map((s) => [s.path, s]));
  const acc = new Map<string, { session: SessionSummary; since: number; details: { at: number; text: string }[]; playbook?: NeedsYouRow["playbook"] }>();
  for (const it of digest.items) {
    if (!listsInNeedsYou(it)) continue;
    const session = byPath.get(it.path);
    if (!session) continue;
    let a = acc.get(it.path);
    if (!a) acc.set(it.path, (a = { session, since: it.since, details: [] }));
    a.since = Math.max(a.since, it.since);
    if (it.detail) a.details.push({ at: it.since, text: it.detail });
    if (it.kind === "playbook-review" && it.playbook) a.playbook = it.playbook;
  }
  return [...acc.values()]
    .map((a) => {
      // Newest first; the sort is stable, so one time keeps the digest's own order (most urgent kind first).
      const details = a.details.sort((x, y) => y.at - x.at).map((d) => d.text);
      return { session: a.session, since: a.since, details, detail: details[0] ?? null, ...(a.playbook ? { playbook: a.playbook } : {}) };
    })
    .sort((a, b) => b.since - a.since || a.session.path.localeCompare(b.session.path));
}

/** The digest kinds of no session the region lists itself (a project's deploy, §app.project-services/deploy-status;
    WhatsApp sending down, §app.outreach/sender-health). */
const DEPLOY_KINDS: ReadonlySet<AttentionItem["kind"]> = new Set(["deploy-failed", "deploy-request", "whatsapp-down"]);

/**
 * The region's items of no session: a deploy target whose latest deploy failed, an overseer's request to deploy,
 * and WhatsApp sending down. Each opens its page (the project's; Settings → Outreach) and says the digest's own
 * sentence; a search keeps those whose project, folder or sentence matches. Newest first.
 */
export function needsYouItems(digest: Pick<AttentionDigest, "items"> | undefined, query = ""): AttentionItem[] {
  const q = query.trim().toLowerCase();
  return (digest?.items ?? [])
    .filter((it) => DEPLOY_KINDS.has(it.kind) && it.tier === "act" && (!q || `${it.title} ${it.where} ${it.detail ?? ""}`.toLowerCase().includes(q)))
    .sort((a, b) => b.since - a.since || a.id.localeCompare(b.id));
}

/** Whether the digest's 30-item cap dropped act items, so the region may be short. */
export const needsYouCut = (digest: Pick<AttentionDigest, "items" | "counts"> | undefined): boolean =>
  !!digest && digest.counts.act > digest.items.filter((i) => i.tier === "act").length;

/**
 * Whether the region is on screen: ONE rule, read by the region and by the spine's door to it.
 * Omitted at 0 rows, and while Overseer proactivity is Off — or not yet known, so it never flashes
 * in before the first Overseer read says Off.
 */
export const needsYouShown = (proactivity: OverseerProactivity | undefined, rows: number): boolean =>
  !!proactivity && proactivity !== "off" && rows > 0;

/** The stored choice: only "0" (the user collapsed it) closes the region; anything else is open. */
export const storedNeedsYouOpen = (raw: string | null): boolean => raw !== "0";

/** Open while a search is on (every hit visible), else the user's choice for the tab. */
export const needsYouOpen = (input: { stored: boolean; searching: boolean }): boolean => input.searching || input.stored;

/** The head's title: what the region is, with its count. */
export const needsYouTitle = (n: number, deploys = 0, whatsapp = false): string => {
  const others = [...(deploys ? [`${deploys} deploy item${deploys === 1 ? "" : "s"}`] : []), ...(whatsapp ? ["WhatsApp sending"] : [])].join(" and ");
  if (!n) return `${others || "Nothing"} waiting on you.`;
  const sessions = n === 1 ? "The 1 session waiting on you" : `The ${n} sessions waiting on you, newest first`;
  return others ? `${sessions}, and ${others}.` : `${sessions}.`;
};
