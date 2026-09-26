// The org page's Recent Profile Changes (§app.organizations/history-and-revert): the history lines,
// grouped so one act (adding a person, one wrap-up, one referral) reads as one row, each value in
// words. Pure, for tsx --test.

import type { NamedChange, ProfileChange } from "../../shared/orgs";

/** A profile value as one line: lists joined, contact and competence spelled out, empty as a dash. */
export function valueText(field: ProfileChange["field"], v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.length ? v.join(", ") : "—";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (field === "referral") return typeof o.why === "string" ? o.why : "—";
    if (field === "competence")
      return Object.entries(o)
        .map(([skill, c]) => `${skill} ${(c as { level?: number })?.level ?? "?"}/5`)
        .join(", ") || "—";
    const parts = Object.entries(o).filter(([, x]) => typeof x === "string" && x);
    return parts.length ? parts.map(([k, x]) => `${k} ${x}`).join(", ") : "—";
  }
  return String(v);
}

export interface ChangeGroup {
  /** The first change's `at`: a stable key. */
  key: string;
  personId: string;
  name: string;
  by: ProfileChange["by"];
  /** Newest first, as the feed. */
  changes: NamedChange[];
  /** The whole group added the person (it holds their first name line). */
  added: boolean;
}

/** Changes of one act: same person, same writer and session, at most `gapMs` apart. */
export function groupChanges(changes: readonly NamedChange[], gapMs = 5000): ChangeGroup[] {
  const out: ChangeGroup[] = [];
  for (const c of changes) {
    const g = out[out.length - 1];
    const last = g?.changes[g.changes.length - 1];
    const same =
      g &&
      last &&
      g.personId === c.personId &&
      g.by.kind === c.by.kind &&
      g.by.sessionId === c.by.sessionId &&
      !c.revertOf &&
      !last.revertOf &&
      Math.abs(Date.parse(last.at) - Date.parse(c.at)) <= gapMs;
    if (same) g.changes.push(c);
    else out.push({ key: c.at, personId: c.personId, name: c.name, by: c.by, changes: [c], added: false });
  }
  for (const g of out) g.added = g.changes.some((c) => c.field === "name" && (c.from === null || c.from === undefined || c.from === ""));
  return out;
}

/** Whether a change can be reverted: not the line that created the person, and not already undone. */
export const revertible = (c: Pick<ProfileChange, "field" | "from" | "at">, undone: ReadonlySet<string>): boolean =>
  !undone.has(c.at) && !(c.field === "name" && (c.from === null || c.from === undefined || c.from === ""));
