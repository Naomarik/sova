/**
 * The Overseer's id check (§app.overseer/id-check): when a run ends, the session links in its
 * assistant text are looked up among this host's session files; an id that matches none gets a
 * hidden note naming the nearest real id, so the next run corrects the link. The reply itself is
 * never changed, and the client still links every id (§app.overseer/links). Pure but for the
 * lookups the caller passes in.
 */

/** The hidden note's custom type. Like the open-cards note it is state, never input (overseer-tools UserTurns). */
export const ID_NOTE_MESSAGE = "overseer-ids";
/** At most this many unknown ids per note. */
export const ID_NOTE_MAX = 5;
/** An id more single-character edits away than half the longer of the two ids is not close: a link
    whose tail was spliced from another session's id (the audit's case, 16 of 36 characters) is
    still matched, an unrelated id (25 or more edits) is not. */
export const nearMaxEdits = (a: string, b: string): number => Math.floor(Math.max(a.length, b.length) / 2);

/** `sova://s/<id>` and `sova://g/<groupId>/s/<id>`: the session link forms the prompt has it write. */
const LINK = /sova:\/\/(?:g\/[A-Za-z0-9_-]+\/)?s\/([A-Za-z0-9_-]+)/g;

/** Every session id a text links, once each, in order. */
export function linkedSessionIds(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(LINK)) out.add(m[1]!);
  return [...out];
}

/** The assistant text of a run's messages (AgentEndEvent.messages). */
export function assistantText(messages: readonly unknown[]): string {
  const parts: string[] = [];
  for (const raw of messages) {
    const m = raw as { role?: unknown; content?: unknown } | null;
    if (m?.role !== "assistant") continue;
    if (typeof m.content === "string") parts.push(m.content);
    else if (Array.isArray(m.content))
      for (const b of m.content) if (b && typeof b === "object" && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string") parts.push((b as { text: string }).text);
  }
  return parts.join("\n");
}

/** Single-character edits (insert, delete, substitute) from `a` to `b`. */
export function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

/** How many characters two strings share at the start. */
export function sharedStart(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/** The real id nearest `bad`: the fewest edits, the longer shared start breaking a tie; null when none is close (nearMaxEdits). */
export function nearestId(bad: string, ids: Iterable<string>): { id: string; edits: number; shared: number } | null {
  let best: { id: string; edits: number; shared: number } | null = null;
  for (const id of ids) {
    if (id === bad) continue;
    const edits = editDistance(bad, id);
    if (edits > nearMaxEdits(bad, id)) continue;
    const shared = sharedStart(bad, id);
    if (!best || edits < best.edits || (edits === best.edits && shared > best.shared)) best = { id, edits, shared };
  }
  return best;
}

export interface IdCheckDeps {
  /** Whether a session file has this id. */
  known: (id: string) => Promise<boolean>;
  /** Every session id on this host, for the nearest match (read only when an id is unknown). */
  allIds: () => Promise<string[]>;
  /** A session's name (summary-first), for the nearest match's line. */
  name: (id: string) => Promise<string | undefined>;
}

/** The note's `details`: the unknown ids it named and their nearest. */
export interface IdNoteDetails {
  v: 1;
  unknown: { id: string; nearest?: string }[];
}

/**
 * The hidden note for a run's assistant text, or null when every linked id is a session here.
 * "[ids] … - 01a0f3ef12… is no session here; nearest: 01a0f3ef-5c2e-… "Spec tools", same first 8 characters".
 */
export async function idCheckNote(text: string, deps: IdCheckDeps): Promise<{ content: string; details: IdNoteDetails } | null> {
  const unknown: string[] = [];
  for (const id of linkedSessionIds(text)) {
    if (unknown.length >= ID_NOTE_MAX) break;
    if (!(await deps.known(id))) unknown.push(id);
  }
  if (!unknown.length) return null;
  const ids = await deps.allIds();
  const lines: string[] = [];
  const details: IdNoteDetails = { v: 1, unknown: [] };
  for (const bad of unknown) {
    const near = nearestId(bad, ids);
    if (!near) {
      lines.push(`- ${bad} is no session here; no session id is close.`);
      details.unknown.push({ id: bad });
      continue;
    }
    const name = (await deps.name(near.id))?.replace(/\s+/g, " ").trim();
    const shared = near.shared > 0 ? `, same first ${near.shared} character${near.shared === 1 ? "" : "s"}` : "";
    lines.push(`- ${bad} is no session here; nearest: ${near.id}${name ? ` "${name.replace(/"/g, "'")}"` : ""}${shared}.`);
    details.unknown.push({ id: bad, nearest: near.id });
  }
  const head =
    "[ids] Your last reply linked session ids that match no session on this host. Correct each link at the start of your next reply, with the id copied from a tool's output (sova_list_sessions with a query, or sova_session); never retype one:";
  return { content: [head, ...lines].join("\n"), details };
}
