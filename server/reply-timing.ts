// Reply timing (§app.insights/reply-timing): one assistant reply's wait, thinking and reply windows,
// folded from the driving session's live events (shared/harness-session.ts) as the chat hears them.
// Pure: no I/O, the clock injected; the chat (server/chat-manager.ts) feeds it every event and writes
// the record (server/perf-record.ts) for a reply it measured.
//
// - The wait for the first token runs from the reply's FIRST `request.start` (the agent's own request
//   going out, after any wait for a provider slot) to its first part event of any kind, so it includes
//   the provider's retries: a request sent again before any part keeps the earlier start, and an
//   attempt that errors hands its start on to pi's auto-retry (`retry.start` … a new turn and request)
//   until a reply is measured or the retry ends. One heard outside a request's wait (a cache warm
//   reusing past options, while idle or streaming) is never a reply's: with no retry pending,
//   `turn.start` and a run's end drop a pending start, and one after the first part is ignored.
// - Each part (thinking, text, tool call) is timed from its start to its last characters, per content
//   index; parts of a kind are summed. Its end event closes it only when no characters came (Claude's
//   hidden thinking): pi-ai's openai-completions adapter (zai, deepseek, ollama-cloud) sends every
//   part's end at the stream's end, which would stretch a thinking part over the reply text after it.
//   A part whose characters arrive with no start opens at its first characters; one still open at the
//   reply's end closes at its last characters, else there.
// - Only a finished reply (stop, length, toolUse) is measured. Every skip is an explicit branch with its
//   own reason (ReplySkip).
import type { HarnessEvent, HarnessReplySummary } from "../shared/harness";
import type { PerfKind, PerfRecord, PerfStop, PerfWindow } from "./perf-record";

/** Why a finished assistant message wrote no measurement. */
export type ReplySkip =
  /** The message ended with no start heard (the timer joined mid-reply). */
  | "no-start"
  /** The harness gave no reply summary (no provider or model named). */
  | "no-summary"
  | "errored"
  | "aborted"
  /** Any other stop than stop, length or toolUse. */
  | "unfinished"
  /** Made while a compaction ran: housekeeping, not a conversation reply. */
  | "compaction"
  /** A provider marked it as no measurement (a retry inside the reply, HarnessReplySummary.invalid). */
  | "invalid"
  /** No request start was heard for it: its wait can't be told. */
  | "no-request-start"
  /** No part of it ever arrived: no first token. */
  | "no-first-token";

/** One measured reply: ms epoch times, windows in ms. */
export interface ReplyMeasure {
  sentAt: number;
  firstAt: number;
  endAt: number;
  thinking: PerfWindow;
  text: PerfWindow;
  tool: PerfWindow;
  summary: HarnessReplySummary;
  /** The thinking-token count where the split is real (see `reasoningOf`). */
  reasoning?: number;
}

export type ReplyOutcome = { measured: ReplyMeasure } | { skipped: ReplySkip };

type Part = "thinking" | "text" | "tool";
const PART_OF: Record<string, Part> = {
  "thinking.start": "thinking",
  "thinking.end": "thinking",
  thinking: "thinking",
  "text.start": "text",
  "text.end": "text",
  text: "text",
  "tool-call.start": "tool",
  "tool-call.end": "tool",
  "tool-call": "tool",
};

/** A part being written: since `at`, its characters last at `last`. */
interface OpenPart {
  part: Part;
  at: number;
  last?: number;
}

interface Current {
  sentAt?: number;
  firstAt?: number;
  /** Began while a compaction ran. */
  compaction: boolean;
  open: Map<string, OpenPart>;
  windows: Record<Part, PerfWindow>;
}

const FINISHED = new Set<string>(["stop", "length", "toolUse"]);

/**
 * The provider's thinking-token count where the split is real: absent when it reported none, absent
 * when it reported more than the whole output (a bad report), and absent when it reported 0 for a reply
 * that had a thinking part (some adapters say 0 for "not reported": never a claim of no thinking).
 */
export function reasoningOf(summary: HarnessReplySummary, thinking: PerfWindow): number | undefined {
  const r = summary.reasoning;
  if (r === undefined || r > summary.output) return undefined;
  if (r === 0 && thinking.n > 0) return undefined;
  return r;
}

export class ReplyTimer {
  private pendingSentAt: number | undefined;
  /** pi's auto-retry is under way (retry.start … retry.end): the failed attempt's start carries over. */
  private retrying = false;
  private compacting = false;
  private cur: Current | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  /** Feed one event; an assistant message's end answers what became of it, every other event null. */
  observe(event: HarnessEvent): ReplyOutcome | null {
    switch (event.type) {
      case "turn.start":
        // A start heard before the turn (a cache warm while idle) is no request of this turn; a retried
        // attempt's start is.
        if (!this.retrying) this.pendingSentAt = undefined;
        return null;
      case "request.start":
        // The earliest send counts: a request sent again (a rate-limit retry, pi's auto-retry) waits on.
        if (!this.cur) this.pendingSentAt ??= event.at;
        else if (this.cur.firstAt === undefined) this.cur.sentAt ??= event.at;
        // After the first part: not this reply's request (a cache warm), ignored.
        return null;
      case "retry.start":
        this.retrying = true;
        return null;
      case "retry.end":
        // pi ends a retry after the retried reply's end, or when it gives up or is cancelled.
        this.retrying = false;
        return null;
      case "compaction.start":
        this.compacting = true;
        return null;
      case "compaction.end":
        this.compacting = false;
        return null;
      case "run.end":
      case "run.settled":
        if (!this.retrying) this.pendingSentAt = undefined;
        this.cur = undefined;
        return null;
      case "message.start":
        if (event.role !== "assistant") return null;
        this.cur = {
          ...(this.pendingSentAt !== undefined ? { sentAt: this.pendingSentAt } : {}),
          compaction: this.compacting,
          open: new Map(),
          windows: { thinking: { ms: 0, n: 0 }, text: { ms: 0, n: 0 }, tool: { ms: 0, n: 0 } },
        };
        this.pendingSentAt = undefined;
        return null;
      case "message.update":
        if (event.role === "assistant" && event.stream && this.cur) this.piece(this.cur, event.stream.kind, event.stream.index);
        return null;
      case "message.end": {
        if (event.role !== "assistant") return null;
        const sentAt = this.cur?.sentAt;
        const outcome = this.end(event.reply);
        // A failed attempt's start waits for pi's retry (dropped at the run's end if none comes).
        if ("skipped" in outcome && outcome.skipped === "errored" && sentAt !== undefined)
          this.pendingSentAt = this.pendingSentAt === undefined ? sentAt : Math.min(this.pendingSentAt, sentAt);
        if ("measured" in outcome) {
          this.pendingSentAt = undefined;
          this.retrying = false;
        }
        return outcome;
      }
      default:
        return null;
    }
  }

  private piece(cur: Current, kind: string, index: number | undefined): void {
    const part = Object.hasOwn(PART_OF, kind) ? PART_OF[kind]! : undefined;
    if (!part) return;
    const t = this.now();
    cur.firstAt ??= t;
    const key = `${part}:${index ?? -1}`;
    if (kind.endsWith(".end")) {
      const open = cur.open.get(key);
      // An end with no start: the part had no window we saw.
      if (open) this.close(cur, key, open, t);
      return;
    }
    // A start, or characters with no start seen: the window opens now (a second start keeps the first).
    let open = cur.open.get(key);
    if (!open) cur.open.set(key, (open = { part, at: t }));
    if (!kind.endsWith(".start")) open.last = t;
  }

  /** Close a part at its last characters, or at `t` when it had none. */
  private close(cur: Current, key: string, open: OpenPart, t: number): void {
    cur.open.delete(key);
    const w = cur.windows[open.part];
    w.ms += Math.max(0, (open.last ?? t) - open.at);
    w.n++;
  }

  private end(summary: HarnessReplySummary | undefined): ReplyOutcome {
    const cur = this.cur;
    this.cur = undefined;
    if (!cur) return { skipped: "no-start" };
    const t = this.now();
    for (const [key, open] of [...cur.open]) this.close(cur, key, open, t);
    if (!summary) return { skipped: "no-summary" };
    if (summary.stop === "error") return { skipped: "errored" };
    if (summary.stop === "aborted") return { skipped: "aborted" };
    if (!FINISHED.has(summary.stop)) return { skipped: "unfinished" };
    if (cur.compaction || this.compacting) return { skipped: "compaction" };
    if (summary.invalid !== undefined) return { skipped: "invalid" };
    if (cur.sentAt === undefined) return { skipped: "no-request-start" };
    if (cur.firstAt === undefined) return { skipped: "no-first-token" };
    const { thinking, text, tool } = cur.windows;
    const reasoning = reasoningOf(summary, thinking);
    return {
      measured: {
        sentAt: cur.sentAt,
        firstAt: cur.firstAt,
        endAt: t,
        thinking,
        text,
        tool,
        summary,
        ...(reasoning !== undefined ? { reasoning } : {}),
      },
    };
  }
}

/** Who a measured reply's record is for and who writes it. */
export interface PerfRecordContext {
  sid: string;
  entryId: string;
  device: string | null;
  producer: string;
  kind?: PerfKind;
}

/** The store record for a measured reply. */
export function perfRecordOf(m: ReplyMeasure, c: PerfRecordContext): PerfRecord {
  const s = m.summary;
  return {
    v: 1,
    key: `${c.sid}:${c.entryId}`,
    ts: m.endAt,
    device: c.device,
    producer: c.producer,
    sid: c.sid,
    entryId: c.entryId,
    ...(c.kind ? { kind: c.kind } : {}),
    provider: s.provider,
    model: s.model,
    ...(s.responseModel ? { responseModel: s.responseModel } : {}),
    ...(s.effort ? { effort: s.effort } : {}),
    ...(s.providerEffort ? { providerEffort: s.providerEffort } : {}),
    stop: s.stop as PerfStop,
    sentAt: m.sentAt,
    ttftMs: Math.max(0, m.firstAt - m.sentAt),
    thinkingMs: m.thinking.ms,
    replyMs: m.text.ms + m.tool.ms,
    thinking: { ...m.thinking },
    text: { ...m.text },
    tool: { ...m.tool },
    endMs: Math.max(0, m.endAt - m.sentAt),
    output: s.output,
    ...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}),
  };
}
