// Home's Projects section (§app.projects/home-cards): one card per project on this host, from data the page already
// has (the projects list, the session list, the attention digest). Pure and DOM-free: the order, its freezing, and
// which cards show.
import type { AttentionDigest, OverseerProactivity, SessionSummary } from "../../shared/protocol";
import type { ProjectSummary } from "../../shared/projects";
import { needsYouRows, needsYouShown } from "./needs-you";
import { projectDone } from "./project-region";
import { isMainThread } from "./regions";

export interface ProjectCard {
  project: ProjectSummary;
  /** Its chats the Needs-you region lists (0 for all while Overseer proactivity is Off or unknown). */
  needsYou: number;
  /** Its chats running a turn now. */
  working: number;
  /** Its chats still open: neither archived nor done (the sidebar's project heading's count). */
  open: number;
  /** Its archived chats. */
  archived: number;
  /** Its newest chat activity (ms), or null: no chats. */
  lastActivity: number | null;
}

/** Cards shown before Show all: 8, or 6 in a narrow overview (a phone, a folded Fold). */
export const CARD_LIMIT = 8;
export const CARD_LIMIT_NARROW = 6;
/** The overview's width under which the grid is one column (home.css's container query) and 6 cards show. */
export const NARROW_PX = 560;
/** How many cards show before Show all at an overview `width` (px): the limit switches where the columns do. */
export const cardLimitAt = (width: number): number => (width < NARROW_PX ? CARD_LIMIT_NARROW : CARD_LIMIT);
/** The filter field shows above the grid past this many projects. */
export const FILTER_FROM = 8;

const isWorking = (s: SessionSummary): boolean => s.activity?.state === "working" || (!s.live && !!s.busy);
const parsed = (iso: string | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
};

/** The order: needs you first, then the most recently active (or added, with no chats), then by name. */
export function compareCards(a: ProjectCard, b: ProjectCard): number {
  return (
    Number(b.needsYou > 0) - Number(a.needsYou > 0) ||
    (b.lastActivity ?? parsed(b.project.createdAt)) - (a.lastActivity ?? parsed(a.project.createdAt)) ||
    a.project.name.localeCompare(b.project.name) ||
    a.project.id.localeCompare(b.project.id)
  );
}

/** One card per project that isn't archived, sorted. Only this host's projects are ever passed. */
export function projectCards(
  projects: readonly ProjectSummary[],
  sessions: readonly SessionSummary[],
  digest: Pick<AttentionDigest, "items"> | undefined,
  proactivity: OverseerProactivity | undefined,
): ProjectCard[] {
  const live = projects.filter((p) => !p.archived);
  const ids = new Set(live.map((p) => p.id));
  const chats = sessions.filter((s) => isMainThread(s) && !s.archived && !!s.project && ids.has(s.project.projectId));
  // A project's own conversation with its overseer is the overseer's eye, never one of its chats.
  const archivedBy = new Map<string, number>();
  for (const s of sessions)
    if (isMainThread(s) && s.archived && s.project && s.project.kind !== "overseer" && ids.has(s.project.projectId))
      archivedBy.set(s.project.projectId, (archivedBy.get(s.project.projectId) ?? 0) + 1);
  const rows = needsYouRows(digest, chats);
  const shown = needsYouShown(proactivity, rows.length);
  const needs = new Map<string, number>();
  if (shown) for (const r of rows) needs.set(r.session.project!.projectId, (needs.get(r.session.project!.projectId) ?? 0) + 1);
  const byProject = new Map<string, SessionSummary[]>();
  for (const s of chats) {
    const list = byProject.get(s.project!.projectId) ?? [];
    list.push(s);
    byProject.set(s.project!.projectId, list);
  }
  return live
    .map((project): ProjectCard => {
      const mine = byProject.get(project.id) ?? [];
      const times = mine.map((s) => parsed(s.lastActiveAt)).filter((t) => t > 0);
      return {
        project,
        needsYou: needs.get(project.id) ?? 0,
        working: mine.filter(isWorking).length,
        open: mine.filter((s) => s.project!.kind !== "overseer" && !projectDone(s)).length,
        archived: archivedBy.get(project.id) ?? 0,
        lastActivity: times.length ? Math.max(...times) : null,
      };
    })
    .sort(compareCards);
}

/**
 * The cards in a frozen order: ids already on screen keep their places (a card never jumps under a finger), and a new
 * project is appended in its sorted place among the new ones. The section freezes the order on mount only.
 */
export function freezeOrder(prevIds: readonly string[], rows: readonly ProjectCard[]): ProjectCard[] {
  const byId = new Map(rows.map((r) => [r.project.id, r]));
  const kept = prevIds.flatMap((id) => {
    const r = byId.get(id);
    return r ? [r] : [];
  });
  const seen = new Set(prevIds);
  return [...kept, ...rows.filter((r) => !seen.has(r.project.id))];
}

/** Whether the filter field shows: more than FILTER_FROM cards (archived projects have none, so they never count). */
export const showsFilter = (cards: readonly ProjectCard[]): boolean => cards.length > FILTER_FROM;

/** Which cards show: up to the limit unless expanded; a filter (a name substring, any case) shows every match. */
export function visibleCards(rows: readonly ProjectCard[], opts: { limit: number; expanded: boolean; filter: string }): ProjectCard[] {
  const q = opts.filter.trim().toLowerCase();
  if (q) return rows.filter((r) => r.project.name.toLowerCase().includes(q));
  return opts.expanded ? [...rows] : rows.slice(0, opts.limit);
}

/** "~/code/acme": a folder with the home folder shortened. */
export function shortFolder(root: string, home: string | null | undefined): string {
  if (home && (root === home || root.startsWith(`${home}/`))) return `~${root.slice(home.length)}`;
  return root;
}
