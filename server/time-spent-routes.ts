// Time Spent's two routes (§app.subagents-pane/time-spent-record). Both ask only for the `sessions` grant
// (server/mesh/access.ts): a page reports to the computer hosting the session and reads from it.

import { existsSync, statSync } from "node:fs";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  TIME_SPENT_MAX_BODY_BYTES,
  TIME_SPENT_MAX_DOCS,
  TIME_SPENT_MAX_ID_CHARS,
  TIME_SPENT_MAX_SLICES,
  TIME_SPENT_READ_ROUTE,
  TIME_SPENT_REPORT_ROUTE,
  TIME_SPENT_ROWS,
  type TimeSpentRecord,
  type TimeSpentReport,
  type TimeSpentSlice,
} from "../shared/time-spent";
import { isSessionBusy } from "./chat-handle";
import { readLive } from "./live";
import { resolveSessionPath } from "./paths";
import { idOf, readHead } from "./sessions-index";
import { agentFigures, agentSpans, alignFacts, type AgentSpans, type AlignFacts } from "./time-spent-figures";
import { timeSpentStore } from "./time-spent";
import { rowsOf } from "./transcript-rows";

const ROWS = new Set<string>(TIME_SPENT_ROWS);
/** The longest age a page could mean: anything past it isn't a time the clock could place. */
const MAX_AGE_MS = 366 * 86_400_000;

const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= TIME_SPENT_MAX_ID_CHARS;
const isAge = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_AGE_MS;

function parseSlice(v: unknown): TimeSpentSlice | null {
  const s = v as Partial<TimeSpentSlice> | null;
  if (!s || typeof s !== "object") return null;
  if (!isId(s.row)) return null;
  if (!Number.isInteger(s.sec) || s.sec! < 1 || s.sec! > 86_400) return null;
  if (!isAge(s.ageMs)) return null;
  if (!Array.isArray(s.docs) || s.docs.length > TIME_SPENT_MAX_DOCS || !s.docs.every(isId)) return null;
  if (s.id !== undefined && (!Number.isSafeInteger(s.id) || s.id < 0)) return null;
  // A row from a newer page reads as Other here: the seconds still count, and the report's other rows aren't lost with it.
  return { row: ROWS.has(s.row) ? s.row : "other", sec: s.sec!, ageMs: s.ageMs, docs: s.docs, ...(s.id !== undefined ? { id: s.id } : {}) };
}

/** The report, every field checked: a page feeds this route, so nothing unbounded reaches the record. */
export function parseTimeSpentReport(v: unknown): TimeSpentReport | null {
  const r = v as Partial<TimeSpentReport> | null;
  if (!r || typeof r !== "object" || Array.isArray(r)) return null;
  if (!isId(r.pageId) || typeof r.path !== "string" || !isAge(r.inputAgeMs)) return null;
  if (!Array.isArray(r.slices) || r.slices.length > TIME_SPENT_MAX_SLICES) return null;
  const slices: TimeSpentSlice[] = [];
  for (const raw of r.slices) {
    const s = parseSlice(raw);
    if (!s) return null;
    slices.push(s);
  }
  return { pageId: r.pageId, path: r.path, inputAgeMs: r.inputAgeMs, slices };
}

/** A file this big costs a visible moment to read, so a section left open reads it at most this often. */
const BIG_FILE_BYTES = 8 * 1024 * 1024;
const BIG_FILE_REREAD_MS = 60_000;

interface Facts {
  stamp: string;
  readAt: number;
  spans: AgentSpans;
  aligns: AlignFacts[];
}
const factsMemo = new Map<string, Facts>();
const FACTS_KEPT = 16;

async function transcriptFacts(path: string, now: number): Promise<Facts> {
  const st = statSync(path);
  const stamp = `${st.size}:${st.mtimeMs}`;
  const had = factsMemo.get(path);
  if (had && (had.stamp === stamp || (st.size > BIG_FILE_BYTES && now - had.readAt < BIG_FILE_REREAD_MS))) return had;
  // The whole active branch, read from the file: never what a page has loaded, and never a write.
  const rows = await rowsOf(path);
  const facts: Facts = { stamp, readAt: now, spans: agentSpans(rows.branch), aligns: alignFacts(rows.items) };
  factsMemo.delete(path);
  factsMemo.set(path, facts);
  if (factsMemo.size > FACTS_KEPT) factsMemo.delete(factsMemo.keys().next().value!);
  return facts;
}

/** Working now: this server's own chat, or a TUI's live record saying so. */
const agentRunning = (path: string): boolean => isSessionBusy(path) || readLive().get(path)?.activity?.state === "working";

/** The session's record as the section reads it. */
export async function readTimeSpent(path: string, now = Date.now()): Promise<TimeSpentRecord> {
  const store = timeSpentStore();
  const facts = await transcriptFacts(path, now);
  const sums = store.sums(idOf(path));
  const head = await readHead(path).catch(() => null);
  const began = Date.parse(head?.header?.timestamp ?? "");
  return {
    you: sums.you,
    rows: sums.rows,
    ...agentFigures(facts.spans, agentRunning(path), now),
    alignments: facts.aligns.map((a) => {
      const doc = sums.docs.get(a.docId);
      const firstShownAt = doc?.firstShownAt ?? null;
      // Decided before this record ever saw it on screen: no span to give.
      const toDecided = firstShownAt !== null && a.decidedAt !== null && a.decidedAt >= firstShownAt ? Math.round((a.decidedAt - firstShownAt) / 1000) : null;
      return { docId: a.docId, title: a.title, toRead: a.toRead, onScreen: doc?.onScreen ?? 0, firstShownAt, toDecided };
    }),
    older: Number.isFinite(began) && began < store.since(now),
  };
}

const badPath = (c: Context) => c.json({ error: "Invalid or missing path (must be a .jsonl under the pi sessions dir)" }, 400);

export function registerTimeSpentRoutes(app: Hono): void {
  // From this start on, a new session's whole time is in its record: older ones say theirs wasn't.
  try {
    timeSpentStore().since();
  } catch (err) {
    console.error("[time-spent] could not note when recording began", err);
  }

  app.post(
    TIME_SPENT_REPORT_ROUTE,
    bodyLimit({ maxSize: TIME_SPENT_MAX_BODY_BYTES, onError: (c) => c.json({ error: "Report too large" }, 400) }),
    async (c) => {
      // Stamped on arrival, before anything can delay it: this computer's time is what places the seconds.
      const now = Date.now();
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "Expected a JSON report" }, 400);
      }
      const report = parseTimeSpentReport(body);
      if (!report) return c.json({ error: "Not a Time Spent report" }, 400);
      const path = resolveSessionPath(report.path);
      if (!path) return badPath(c);
      // A session deleted under an open page: its record stays gone.
      if (existsSync(path)) timeSpentStore().report(idOf(path), report, now);
      return c.json({ ok: true });
    },
  );

  app.get(TIME_SPENT_READ_ROUTE, async (c) => {
    const path = resolveSessionPath(c.req.query("path"));
    if (!path) return badPath(c);
    if (!existsSync(path)) return c.json({ error: "Session file not found" }, 404);
    return c.json(await readTimeSpent(path));
  });
}
