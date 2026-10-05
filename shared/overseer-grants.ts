/**
 * Approvals for later and standing rules (§app.overseer/approvals): what lets a run the user did
 * not start act anyway. Both come only from the user's click on a card option that proposed one;
 * the server writes them as hidden custom entries in the Overseer's file, which no tool and no
 * model output can write. This module is the pure part: the entry shapes, the grant or rule a
 * click writes, the fold of a file's entries, and the coverage check the acting tools run.
 *
 * Pure TS, no DOM and no node: the server (the click, the tools, the route) and the client (the
 * chip, the panel, the card's state line) read one shape.
 */
import type { CardClick, CardOption, OverseerCard } from "./overseer-card";

/** An answer option by its letter (link options carry none): overseer-card's rule, kept here so
    this module imports nothing at runtime from it (overseer-card imports this one). */
function optionByLetter(card: Pick<OverseerCard, "options">, letter: string): CardOption | undefined {
  const i = letter.charCodeAt(0) - 97;
  return /^[a-z]$/.test(letter) ? card.options.filter((o) => !o.href)[i] : undefined;
}

/** customTypes of the server-written entries. */
export const GRANT_ENTRY = "overseer-grant";
export const RULE_ENTRY = "overseer-rule";
export const REVOKE_ENTRY = "overseer-revoke";
export const USE_ENTRY = "overseer-grant-use";

/** The acts an approval or rule can cover: the tools that act on named sessions. */
export const GRANTABLE_ACTS = ["sova_send", "sova_set_session", "sova_archive", "sova_answer_dialog", "sova_group"] as const;
export type GrantableAct = (typeof GRANTABLE_ACTS)[number];

/** A grant's default length after its `at`, and how far ahead a card may approve. */
export const GRANT_DEFAULT_MS = 60 * 60_000;
export const GRANT_MAX_AHEAD_MS = 7 * 24 * 60 * 60_000;

/** A card option's approval for later: when the Overseer means to act, and the deadline. */
export interface CardOptionLater {
  /** ISO. */
  at: string;
  /** ISO; the approval's deadline. Absent: an hour after `at`. */
  until?: string;
}

/** A card option's proposed standing rule. */
export interface CardOptionRule {
  text: string;
  /** The acts it covers; absent means every grantable act. */
  acts?: GrantableAct[];
  /** Any session on this host, not only the card's listed ones. */
  anySession?: true;
}

export interface PermitSession {
  id: string;
  title: string;
}

interface PermitBase {
  v: 1;
  /** `g_N` or `r_N`. */
  id: string;
  /** The card and option letter whose click wrote it. */
  card: string;
  option: string;
  /** The option's label. */
  label: string;
  /** ISO. */
  createdAt: string;
  /** The user message entry the click composed. */
  message: string;
}

export interface GrantEntry extends PermitBase {
  sessions: PermitSession[];
  at: string;
  until: string;
}

export interface RuleEntry extends PermitBase {
  text: string;
  acts: GrantableAct[];
  /** The listed sessions, or "any". */
  sessions: PermitSession[] | "any";
  /** Carried over a /clear: the id of the earlier Overseer conversation its card lives in. */
  from?: string;
}

export interface RevokeEntry {
  v: 1;
  id: string;
  at: string;
  by: "user";
}

export interface UseEntry {
  v: 1;
  id: string;
  tool: string;
  sessions: string[];
  toolCallId: string;
  at: string;
}

export type PermitStatus = "live" | "expired" | "revoked";

/** One grant or rule as the chip, the panel and the card read it. */
export interface Permit {
  kind: "grant" | "rule";
  id: string;
  card: string;
  option: string;
  label: string;
  createdAt: string;
  sessions: PermitSession[] | "any";
  acts: GrantableAct[];
  /** A rule's instruction. */
  text?: string;
  /** A grant's planned time and deadline. */
  at?: string;
  until?: string;
  status: PermitStatus;
  revokedAt?: string;
  /** A rule carried over a /clear: the earlier conversation its card lives in. */
  from?: string;
  uses: Omit<UseEntry, "v" | "id">[];
}

// ── Stored-shape checks ──────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const isTime = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
const isAct = (v: unknown): v is GrantableAct => typeof v === "string" && (GRANTABLE_ACTS as readonly string[]).includes(v);
const GRANT_ID = /^g_[1-9]\d*$/;
const RULE_ID = /^r_[1-9]\d*$/;

function sessionsOf(v: unknown): PermitSession[] | undefined {
  if (!Array.isArray(v) || v.length === 0) return undefined;
  const out: PermitSession[] = [];
  for (const s of v) {
    if (!isRecord(s) || !nonEmpty(s.id) || typeof s.title !== "string") return undefined;
    out.push({ id: s.id, title: s.title });
  }
  return out;
}

function baseOf(v: Record<string, unknown>): Omit<PermitBase, "id"> | undefined {
  if (v.v !== 1 || !/^c_[1-9]\d*$/.test(String(v.card)) || !/^[a-z]$/.test(String(v.option))) return undefined;
  if (!nonEmpty(v.label) || !isTime(v.createdAt) || !nonEmpty(v.message)) return undefined;
  return { v: 1, card: v.card as string, option: v.option as string, label: v.label, createdAt: v.createdAt, message: v.message };
}

export function normalizeGrant(v: unknown): GrantEntry | undefined {
  if (!isRecord(v) || !GRANT_ID.test(String(v.id))) return undefined;
  const base = baseOf(v);
  const sessions = sessionsOf(v.sessions);
  if (!base || !sessions || !isTime(v.at) || !isTime(v.until)) return undefined;
  return { ...base, id: v.id as string, sessions, at: v.at, until: v.until };
}

export function normalizeRule(v: unknown): RuleEntry | undefined {
  if (!isRecord(v) || !RULE_ID.test(String(v.id))) return undefined;
  const base = baseOf(v);
  if (!base || !nonEmpty(v.text) || !Array.isArray(v.acts) || v.acts.length === 0 || !v.acts.every(isAct)) return undefined;
  const sessions = v.sessions === "any" ? "any" : sessionsOf(v.sessions);
  if (!sessions) return undefined;
  return { ...base, id: v.id as string, text: v.text, acts: [...(v.acts as GrantableAct[])], sessions, ...(nonEmpty(v.from) ? { from: v.from } : {}) };
}

export function normalizeRevoke(v: unknown): RevokeEntry | undefined {
  if (!isRecord(v) || v.v !== 1 || !(GRANT_ID.test(String(v.id)) || RULE_ID.test(String(v.id))) || !isTime(v.at)) return undefined;
  return { v: 1, id: v.id as string, at: v.at, by: "user" };
}

export function normalizeUse(v: unknown): UseEntry | undefined {
  if (!isRecord(v) || v.v !== 1 || !(GRANT_ID.test(String(v.id)) || RULE_ID.test(String(v.id))) || !nonEmpty(v.tool) || !isTime(v.at)) return undefined;
  if (!Array.isArray(v.sessions) || !v.sessions.every(nonEmpty) || typeof v.toolCallId !== "string") return undefined;
  return { v: 1, id: v.id as string, tool: v.tool, sessions: [...(v.sessions as string[])], toolCallId: v.toolCallId, at: v.at };
}

/** A `custom` entry of one of our types, its data; else undefined. Only `type: "custom"` entries
    count: a message, a tool result or a custom MESSAGE (what an extension can send) never does. */
function customOf(entry: unknown, type: string): unknown {
  if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== type) return undefined;
  return entry.data;
}

// ── Fold ─────────────────────────────────────────────────────────────────────

/**
 * Every grant and rule of a conversation. Grants and rules are read from `branch` (a rewind that
 * drops the click drops what it wrote); revokes and uses from `all`, the whole file, so a rewind
 * never brings a revoked one back. `now` decides expiry.
 */
export function foldPermits(branch: readonly unknown[], all: readonly unknown[], now: number): Permit[] {
  const revoked = new Map<string, string>();
  const uses = new Map<string, Omit<UseEntry, "v" | "id">[]>();
  for (const e of all) {
    const r = normalizeRevoke(customOf(e, REVOKE_ENTRY));
    if (r && !revoked.has(r.id)) revoked.set(r.id, r.at);
    const u = normalizeUse(customOf(e, USE_ENTRY));
    if (u) uses.set(u.id, [...(uses.get(u.id) ?? []), { tool: u.tool, sessions: u.sessions, toolCallId: u.toolCallId, at: u.at }]);
  }
  const out: Permit[] = [];
  const seen = new Set<string>();
  for (const e of branch) {
    const g = normalizeGrant(customOf(e, GRANT_ENTRY));
    const r = g ? undefined : normalizeRule(customOf(e, RULE_ENTRY));
    const p = g ?? r;
    if (!p || seen.has(p.id)) continue;
    seen.add(p.id);
    const revokedAt = revoked.get(p.id);
    const common = { id: p.id, card: p.card, option: p.option, label: p.label, createdAt: p.createdAt, uses: uses.get(p.id) ?? [], ...(revokedAt ? { revokedAt } : {}) };
    if (g) {
      const status: PermitStatus = revokedAt ? "revoked" : Date.parse(g.until) <= now ? "expired" : "live";
      out.push({ ...common, kind: "grant", sessions: g.sessions, acts: [...GRANTABLE_ACTS], at: g.at, until: g.until, status });
    } else if (r) {
      out.push({ ...common, kind: "rule", sessions: r.sessions, acts: r.acts, text: r.text, status: revokedAt ? "revoked" : "live", ...(r.from ? { from: r.from } : {}) });
    }
  }
  return out;
}

/**
 * What `/clear` carries into the new conversation: each rule still live in the old one (`branch`
 * and `all` as foldPermits reads them), as the entry to append there, same id, text, acts,
 * sessions, card and option, with `from` the conversation its card lives in (`oldId`, or the one
 * it already names when carried before). Approvals for later, revoked rules and uses never carry.
 */
export function carriedRules(branch: readonly unknown[], all: readonly unknown[], oldId: string): RuleEntry[] {
  const live = new Set(foldPermits(branch, all, Date.now()).filter((p) => p.kind === "rule" && p.status === "live").map((p) => p.id));
  const out: RuleEntry[] = [];
  for (const e of branch) {
    const r = normalizeRule(customOf(e, RULE_ENTRY));
    if (!r || !live.has(r.id)) continue;
    live.delete(r.id);
    out.push({ ...r, from: r.from ?? oldId });
  }
  return out;
}

/** The next `g_N` / `r_N` of a file: one past the highest ever written in it, on any branch. */
export function nextPermitId(all: readonly unknown[], kind: "grant" | "rule"): string {
  const prefix = kind === "grant" ? "g_" : "r_";
  let max = 0;
  for (const e of all) {
    const d = customOf(e, kind === "grant" ? GRANT_ENTRY : RULE_ENTRY);
    const id = isRecord(d) ? String(d.id) : "";
    if (id.startsWith(prefix)) max = Math.max(max, Number(id.slice(2)) || 0);
  }
  return `${prefix}${max + 1}`;
}

/**
 * The live grant or rule that covers `tool` on every one of `sessions`, or undefined. An act that
 * names no session is never covered. A grant covers every grantable act on its sessions; a rule
 * the acts it names on its sessions (or any session).
 */
export function coveringPermit(permits: readonly Permit[], tool: string, sessions: readonly string[], now: number): Permit | undefined {
  if (!isAct(tool) || sessions.length === 0) return undefined;
  return permits.find((p) => {
    if (p.status !== "live") return false;
    if (p.kind === "grant" && (!p.until || Date.parse(p.until) <= now)) return false;
    if (!p.acts.includes(tool)) return false;
    if (p.sessions === "any") return true;
    const ids = new Set(p.sessions.map((s) => s.id));
    return sessions.every((id) => ids.has(id));
  });
}

/** The live permits (the chip's count). */
export const livePermits = (permits: readonly Permit[]): Permit[] => permits.filter((p) => p.status === "live");

/** "2 approvals · 1 rule"; "" when none is live. */
export function permitsChipText(permits: readonly Permit[]): string {
  const live = livePermits(permits);
  const g = live.filter((p) => p.kind === "grant").length;
  const r = live.length - g;
  const parts: string[] = [];
  if (g) parts.push(`${g} approval${g === 1 ? "" : "s"}`);
  if (r) parts.push(`${r} rule${r === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

// ── The click ────────────────────────────────────────────────────────────────

/**
 * What an exact click on `card` (already matched, `matchCardClick`) writes: a grant for an option
 * with `later`, a rule for one with `rule`, else nothing. `all` numbers it; `message` is the click's
 * user message entry id. Pure.
 */
export function permitFromClick(
  card: OverseerCard,
  click: CardClick,
  all: readonly unknown[],
  message: string,
  now: string,
): { type: typeof GRANT_ENTRY; data: GrantEntry } | { type: typeof RULE_ENTRY; data: RuleEntry } | undefined {
  if (!("option" in click)) return undefined;
  const opt = optionByLetter(card, click.option);
  if (!opt || (!opt.later && !opt.rule)) return undefined;
  // Named as the card named them: summary-first (§app.overseer/session-names).
  const sessions = card.items.filter((it) => it.kind === "session").map((it) => {
    const s = it as { title: string; summary?: string };
    return { id: it.id, title: s.summary?.trim() || s.title };
  });
  const base = { v: 1 as const, card: card.id, option: click.option, label: opt.label, createdAt: now, message };
  if (opt.later) {
    if (!sessions.length) return undefined;
    const until = opt.later.until ?? new Date(Date.parse(opt.later.at) + GRANT_DEFAULT_MS).toISOString();
    return { type: GRANT_ENTRY, data: { ...base, id: nextPermitId(all, "grant"), sessions, at: opt.later.at, until } };
  }
  const rule = opt.rule!;
  const scope: PermitSession[] | "any" = rule.anySession ? "any" : sessions;
  if (scope !== "any" && !scope.length) return undefined;
  return { type: RULE_ENTRY, data: { ...base, id: nextPermitId(all, "rule"), text: rule.text, acts: rule.acts?.length ? [...rule.acts] : [...GRANTABLE_ACTS], sessions: scope } };
}

/** Whether a message entry id already has a grant or rule (a click writes at most one). */
export function clickWrote(all: readonly unknown[], message: string): boolean {
  return all.some((e) => {
    const d = customOf(e, GRANT_ENTRY) ?? customOf(e, RULE_ENTRY);
    return isRecord(d) && d.message === message;
  });
}

// ── Words ────────────────────────────────────────────────────────────────────

const ACT_WORDS: Record<GrantableAct, string> = {
  sova_send: "send",
  sova_set_session: "set",
  sova_archive: "archive",
  sova_answer_dialog: "answer dialogs",
  sova_group: "group",
};
export const actsText = (acts: readonly GrantableAct[]): string =>
  acts.length === GRANTABLE_ACTS.length ? "any act" : acts.map((a) => ACT_WORDS[a]).join(", ");

/** "these 3 sessions" / "this session" / "any session". */
export const sessionsText = (sessions: PermitSession[] | "any" | number): string => {
  const n = sessions === "any" ? -1 : typeof sessions === "number" ? sessions : sessions.length;
  return n < 0 ? "any session" : n === 1 ? "this session" : `these ${n} sessions`;
};
