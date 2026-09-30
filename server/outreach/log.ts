import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { notSentReason, type OutreachLogLine, type PersonSendRow } from "../../shared/outreach";
import type { AttentionItem } from "../../shared/protocol";
import { orgDir, readIndex, readOrgOrPlaceholder, readProjects, readRoster } from "../orgs";
import { stateRoot } from "../state-root";
import type { Receipt } from "./types";

/**
 * The send log (§app.outreach/log): `<workspace>/outreach.jsonl`, append-only and portable, never a
 * number, token, link, channel message id or message. Receipts are matched host-locally through
 * `<stateRoot>/outreach-receipts.json` (channel ref → the send's log line), kept 7 days.
 */

export const OUTREACH_LOG = "outreach.jsonl";
const RECEIPT_DAYS = 7;

const logFile = (orgId: string): string => join(orgDir(orgId), OUTREACH_LOG);

export const newSendId = (): string => `o_${randomBytes(6).toString("base64url")}`;

export function appendSendLog(orgId: string, line: OutreachLogLine): void {
  const file = logFile(orgId);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(line)}\n`);
}

export function readSendLog(orgId: string): OutreachLogLine[] {
  let text: string;
  try {
    text = readFileSync(logFile(orgId), "utf8");
  } catch {
    return [];
  }
  const out: OutreachLogLine[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const l = JSON.parse(raw) as OutreachLogLine;
      if (l && typeof l.id === "string" && typeof l.personId === "string" && typeof l.event === "string") out.push(l);
    } catch {
      // a torn line: skipped
    }
  }
  return out;
}

const RANK = { refused: 0, failed: 0, unknown: 0, sent: 1, delivered: 2, read: 3 } as const;
const NOT_SENT_DAYS = 7;

/**
 * A project overseer's sends that did not go (§app.outreach/send), as Needs-you items: act tier, kind
 * `outreach-not-sent`, never pushed, opening the person's page. One per send whose last outcome is refused,
 * failed or unknown, until a later send to that person in that project went, or 7 days pass. The reason is
 * said from the log's code: the log keeps no sentence.
 */
export function notSentAttention(now = Date.now()): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const o of readIndex().orgs) {
    let orgName = "";
    let projects: { id: string; name: string; archived?: unknown }[] = [];
    let roster: { id: string; name: string }[] = [];
    try {
      orgName = readOrgOrPlaceholder(o.id).name;
      projects = readProjects(o.id);
      roster = readRoster(o.id);
    } catch {
      continue;
    }
    const last = new Map<string, OutreachLogLine>();
    const went: OutreachLogLine[] = [];
    for (const l of readSendLog(o.id)) {
      const had = last.get(l.id);
      if (!had || (RANK[l.event] ?? 0) >= (RANK[had.event] ?? 0)) last.set(l.id, l);
      if (l.event === "sent") went.push(l);
    }
    for (const l of last.values()) {
      if (l.by !== "project-overseer" || RANK[l.event] !== 0) continue;
      const at = Date.parse(l.at);
      if (!(now - at < NOT_SENT_DAYS * 86_400_000)) continue;
      if (went.some((w) => w.personId === l.personId && w.projectId === l.projectId && Date.parse(w.at) > at)) continue;
      const p = projects.find((x) => x.id === l.projectId);
      const name = roster.find((x) => x.id === l.personId)?.name ?? "someone";
      out.push({
        id: `outreach-not-sent:${l.id}`,
        path: "",
        title: p?.name ?? orgName,
        where: orgName,
        tier: "act",
        kind: "outreach-not-sent",
        since: at || 0,
        detail: `The WhatsApp message to ${name} was not sent: ${notSentReason(l.code)}.`,
        href: `#/orgs/${encodeURIComponent(o.id)}/people/${encodeURIComponent(l.personId)}`,
        org: { orgId: o.id, orgName, ...(p ? { projectId: p.id, projectName: p.name, ...(p.archived ? { projectArchived: true as const } : {}) } : {}) },
      });
    }
  }
  return out;
}

/** One send of a project as its overseer reads it (sova_send_status): never a number, a link or the note. */
export interface ProjectSend {
  id: string;
  personId: string;
  link?: OutreachLogLine["link"];
  note: boolean;
  by: OutreachLogLine["by"];
  /** The latest event (a receipt moves a send on, never back), its code and when it was logged. */
  event: OutreachLogLine["event"];
  code?: string;
  at: string;
  /** When the send was first logged. */
  sentAt: string;
}

/** A project's sends, newest first by their latest event. */
export function projectSends(orgId: string, projectId: string): ProjectSend[] {
  const byId = new Map<string, ProjectSend>();
  for (const l of readSendLog(orgId)) {
    if (l.projectId !== projectId) continue;
    const had = byId.get(l.id);
    if (had && (RANK[l.event] ?? 0) < (RANK[had.event] ?? 0)) continue;
    byId.set(l.id, {
      id: l.id,
      personId: l.personId,
      ...(l.link ?? had?.link ? { link: l.link ?? had?.link } : {}),
      note: !!(l.note ?? had?.note),
      by: had?.by ?? l.by,
      event: l.event,
      ...(l.code ? { code: l.code } : {}),
      at: l.at,
      sentAt: had?.sentAt ?? l.at,
    });
  }
  return [...byId.values()].sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
}

// ---- what a look has noted -----------------------------------------------------------------------

/** Host-local: per project, the latest time of a send that did not go that a look already noted. */
const notedFile = (): string => join(stateRoot(), "outreach-noted.json");

function readNoted(): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(notedFile(), "utf8"));
    return raw && typeof raw === "object" && raw.projects && typeof raw.projects === "object" ? raw.projects : {};
  } catch {
    return {};
  }
}

/**
 * The project overseer's own sends that ended refused, failed or unknown and no look has noted yet
 * (§app.project-overseer/tools), oldest first; none older than 7 days.
 */
export function sendsToNote(orgId: string, projectId: string, now = Date.now()): ProjectSend[] {
  const since = readNoted()[`${orgId}/${projectId}`] ?? "";
  const floor = new Date(now - NOT_SENT_DAYS * 86_400_000).toISOString();
  return projectSends(orgId, projectId)
    .filter((s) => s.by === "project-overseer" && RANK[s.event] === 0 && s.at > since && s.at > floor)
    .reverse();
}

/** A look noted these: later looks don't repeat them. */
export function markSendsNoted(orgId: string, projectId: string, sends: ProjectSend[]): void {
  if (!sends.length) return;
  const all = readNoted();
  const k = `${orgId}/${projectId}`;
  const latest = sends.reduce((m, s) => (s.at > m ? s.at : m), all[k] ?? "");
  all[k] = latest;
  const path = notedFile();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, projects: all })}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** A person's sends, newest first: the latest event of each (a receipt moves a send on, never back). */
export function personSends(orgId: string, personId: string, titleOf: (sessionId: string) => string | undefined): PersonSendRow[] {
  const rank = RANK;
  const byId = new Map<string, { first: OutreachLogLine; last: OutreachLogLine }>();
  for (const l of readSendLog(orgId)) {
    if (l.personId !== personId) continue;
    const had = byId.get(l.id);
    if (!had) byId.set(l.id, { first: l, last: l });
    else if ((rank[l.event] ?? 0) >= (rank[had.last.event] ?? 0)) had.last = { ...l, sessionId: l.sessionId ?? had.last.sessionId };
  }
  const whatOf = (l: OutreachLogLine): string =>
    l.link === "preview" ? "A preview" : l.sessionId ? (titleOf(l.sessionId) ?? "A gathering") : l.link ? "A link" : "A message";
  return [...byId.values()]
    .map(({ first, last }) => ({
      id: first.id,
      at: first.at,
      what: whatOf(last.sessionId || last.previewId ? last : first),
      ...(first.sessionId ?? last.sessionId ? { sessionId: (first.sessionId ?? last.sessionId)! } : {}),
      channel: first.channel,
      event: last.event,
      ...(last.code ? { code: last.code } : {}),
    }))
    .sort((a, b) => b.at.localeCompare(a.at));
}

// ---- receipts ------------------------------------------------------------------------------------

interface ReceiptEntry {
  orgId: string;
  line: Omit<OutreachLogLine, "at" | "event" | "code">;
  sentAt: string;
  /** The events already logged for it. */
  logged: string[];
}

const receiptsFile = (): string => join(stateRoot(), "outreach-receipts.json");

function readReceipts(): Record<string, ReceiptEntry> {
  try {
    const raw = JSON.parse(readFileSync(receiptsFile(), "utf8"));
    return raw && typeof raw === "object" && raw.refs && typeof raw.refs === "object" ? raw.refs : {};
  } catch {
    return {};
  }
}

function writeReceipts(refs: Record<string, ReceiptEntry>, now = Date.now()): void {
  const keep: Record<string, ReceiptEntry> = {};
  for (const [ref, e] of Object.entries(refs)) if (now - Date.parse(e.sentAt) < RECEIPT_DAYS * 86_400_000) keep[ref] = e;
  const path = receiptsFile();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, refs: keep })}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** Remember a sent message's ref so its receipts find its log line. */
export function rememberRef(ref: string, orgId: string, line: OutreachLogLine): void {
  const refs = readReceipts();
  const { at, event: _e, code: _c, ...rest } = line;
  refs[ref] = { orgId, line: rest, sentAt: at, logged: ["sent"] };
  writeReceipts(refs);
}

/** A receipt: one `delivered`, `read` or `failed` line per send, once each (a replay logs nothing). */
export function applyReceipt(r: Receipt, now = Date.now()): boolean {
  const refs = readReceipts();
  const e = refs[r.ref];
  if (!e || e.logged.includes(r.status)) return false;
  e.logged.push(r.status);
  appendSendLog(e.orgId, { at: new Date(now).toISOString(), ...e.line, event: r.status, ...(r.code ? { code: r.code } : {}) });
  writeReceipts(refs, now);
  return true;
}
