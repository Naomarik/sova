import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { OutreachLogLine, PersonSendRow } from "../../shared/outreach";
import { orgDir } from "../orgs";
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

/** A person's sends, newest first: the latest event of each (a receipt moves a send on, never back). */
export function personSends(orgId: string, personId: string, titleOf: (sessionId: string) => string | undefined): PersonSendRow[] {
  const rank = { refused: 0, failed: 0, sent: 1, delivered: 2, read: 3 } as const;
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
