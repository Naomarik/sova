// The Context tab's Everyone view: which skills this chat and all its workers opened, over each one's whole
// history, most-read first, and the skills offered that nobody opened. Each opening counts once, as
// server/skills.ts records it (a /skill: run, a read of its SKILL.md, a shell print of it): paged reads
// aren't joined and nothing is marked partly read. Pure (no DOM, no Solid), so it tests under tsx.

import type { SessionSkills, SessionSkillUse } from "../../shared/protocol";
import type { ContextPart } from "./context-parts";

/** One chat whose record counts: this chat or one of its workers. `key` is what Whose context picks it by. */
export interface SkillReaderSource {
  key: string;
  label: string;
  skills: SessionSkills | undefined;
}

/** One chat's openings of one skill. */
export interface SkillReader {
  key: string;
  label: string;
  count: number;
  /** ISO time of its latest opening; "" when none carried a time. */
  lastAt: string;
}

/** One skill, as the overview lists it. */
export interface SkillOverviewRow {
  /** Unique in the list: the name, and the SKILL.md path when two of that name were opened. */
  id: string;
  name: string;
  /** The SKILL.md path, only when one name was opened at two or more paths. */
  location?: string;
  /** Every opening, by every chat. */
  total: number;
  /** Most openings first. */
  readers: SkillReader[];
}

export interface SkillsOverview {
  read: SkillOverviewRow[];
  /** Skills offered to any of the chats that none of them opened, by name. */
  notRead: { name: string; description?: string; location?: string }[];
}

/** A path that names one file wherever it was read from. A relative one, or none, says nothing of which. */
const absolute = (p: string | undefined): p is string => !!p && (p.startsWith("/") || p.startsWith("~/") || /^[A-Za-z]:[\\/]/.test(p));

const later = (a: string, b: string): string => (Date.parse(b) > Date.parse(a) || (!a && b) ? b : a);

/** The overview of every source given. Grouped by skill name, split by SKILL.md path only when one name was
    opened at more than one; an opening with no path of its own then stands under the name alone. Ties: more
    chats first, then by name; a skill's readers, latest first on a tie. Pure. */
export function skillsOverview(sources: readonly SkillReaderSource[]): SkillsOverview {
  const paths = new Map<string, Set<string>>();
  for (const s of sources) for (const u of s.skills?.used ?? []) if (absolute(u.location)) (paths.get(u.name) ?? paths.set(u.name, new Set()).get(u.name)!).add(u.location);
  const groupOf = (u: SessionSkillUse): { id: string; location?: string } => {
    const split = (paths.get(u.name)?.size ?? 0) > 1;
    return split && absolute(u.location) ? { id: `${u.name}@${u.location}`, location: u.location } : { id: u.name };
  };
  const rows = new Map<string, { row: SkillOverviewRow; by: Map<string, SkillReader> }>();
  for (const s of sources) {
    for (const u of s.skills?.used ?? []) {
      const g = groupOf(u);
      let r = rows.get(g.id);
      if (!r) rows.set(g.id, (r = { row: { id: g.id, name: u.name, ...(g.location ? { location: g.location } : {}), total: 0, readers: [] }, by: new Map() }));
      r.row.total++;
      const who = r.by.get(s.key);
      if (who) {
        who.count++;
        who.lastAt = later(who.lastAt, u.at);
      } else r.by.set(s.key, { key: s.key, label: s.label, count: 1, lastAt: u.at });
    }
  }
  const read = [...rows.values()].map(({ row, by }) => ({
    ...row,
    readers: [...by.values()].sort((a, b) => b.count - a.count || (Date.parse(b.lastAt) || 0) - (Date.parse(a.lastAt) || 0) || a.label.localeCompare(b.label)),
  }));
  read.sort((a, b) => b.total - a.total || b.readers.length - a.readers.length || a.name.localeCompare(b.name) || (a.location ?? "").localeCompare(b.location ?? ""));
  const opened = new Set(read.map((r) => r.name));
  const notRead = new Map<string, { name: string; description?: string; location?: string }>();
  for (const s of sources) {
    for (const o of s.skills?.offered ?? []) {
      if (opened.has(o.name) || notRead.has(o.name)) continue;
      notRead.set(o.name, { name: o.name, ...(o.description ? { description: o.description } : {}), ...(o.location ? { location: o.location } : {}) });
    }
  }
  return { read, notRead: [...notRead.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

/** A skill row's short line: "12 openings · 3 chats". Pure. */
export function overviewMeta(r: Pick<SkillOverviewRow, "total" | "readers">): string {
  const n = r.readers.length;
  return `${r.total} ${r.total === 1 ? "opening" : "openings"} · ${n} ${n === 1 ? "chat" : "chats"}`;
}

/** Whether a skill the window shows as not read was opened before the chat's latest compaction: the
    whole-history record has an opening of it. Matched by name, and by path where both name one. Only a
    skill offered in the window and not read there at all qualifies. Pure. */
export function readBeforeCompaction(p: Pick<ContextPart, "group" | "label" | "path" | "read" | "linesRead" | "manualOnly" | "offered">, used: readonly SessionSkillUse[] | undefined): boolean {
  if (p.group !== "skills" || p.read || p.linesRead || p.manualOnly || p.offered === false || !used) return false;
  return used.some((u) => u.name === p.label && !(p.path && u.location?.startsWith("/") && u.location !== p.path));
}
