/**
 * Chain of summarizer backends with per-backend backoff, plus the shared
 * prompt builder and defensive JSON parser used by every backend.
 */

import { claimOf } from "../claims.ts";
import type { Summarizer, SummarizeInput, SummarizerResult } from "../types.ts";
import { SummarizerError } from "../types.ts";

const BACKOFF_STEPS_MS = [60_000, 300_000, 900_000];

export function buildPrompt(input: SummarizeInput): string {
  const lookback = input.lookbackLines ?? [];
  return [
    "You maintain a live outline of a coding-agent conversation between USER and ASSISTANT.",
    "The user glances at it to see what the session is for, where things stand, and what came of each thing they asked.",
    "You are shown the existing outline and only the newest messages. Update the outline incrementally.",
    "",
    "Topics:",
    "- A topic is one thing the user asked for or raised. Worker and subagent reports, timers, status checks and",
    "  restarts are not topics: fold them into the topic they serve.",
    '- Prefer updating an existing topic over creating a new one. Use "new" only when the user raises something new.',
    "- A heading names the subject in 1-4 plain words. A heading never states a status (blocked, fixed, done, pending,",
    "  waiting): the summary says how things stand, the heading only what it is about.",
    "",
    "Ranges:",
    "- Split the NEW MESSAGES into consecutive ranges, one per topic you send: each update's \"from\" and \"to\" are the",
    "  first and last message ref of its own range (like \"m3\" and \"m9\"), with from at or before to.",
    "- Each message belongs to exactly one topic. Ranges never overlap; two neighbouring ranges may share only the one",
    "  message where one ends and the next begins. A range that overlaps an earlier one in your list is thrown away.",
    "- Never repeat a fact in two topics. Each fact goes in the topic whose range states it.",
    "- A report that mentions other threads in passing belongs to the range of the ask it answers; the threads it",
    "  mentions get nothing from it.",
    "- EARLIER MESSAGES (refs p1, p2…) are already summarized. Read them only to understand where the new messages",
    "  pick up; never use a p ref in from or to, and never summarize them again.",
    "",
    "Bullets:",
    "- 1-3 bullets per topic, each at most 70 characters, one fact each, in plain words, not needlessly technical.",
    "- For kind=update, send the COMPLETE summary for that topic: your bullets replace the stored ones, and your heading",
    "  replaces the stored heading. Resend the earlier facts that still matter, drop what the new messages made",
    "  obsolete, and add what is new.",
    "- Say what was decided, done or found, never the steps taken to get there. No check times.",
    '- Address the user as "you". Never open with "User asked", "The user", "The assistant" or "Assistant".',
    "- Leave out commit hashes, file and function names, worker ids, and internal names, unless the user typed them.",
    "- Leave out open items, to-dos, next steps and anything still open: the chat is ongoing, and the topics record",
    "  outcomes only. A bullet says what is true now, never what will or should happen next.",
    '  Bad bullet: "The rerun goes ahead once the last fix branch is merged." (a next step: leave it out)',
    "- Only facts the messages state. Never infer a regression, a problem, a cause or a result they don't state.",
    "- Never include secrets, tokens, keys, or commands verbatim.",
    "- Never invent refs or topics outside the provided messages.",
    "",
    '- "now": where things stand right now, at most 60 characters. Never open with an -ing word ("Working on…").',
    '- "overall": what this session is FOR, at most 8 words, starting with its subject.',
    '  Answer "what is this session about?", never "what just happened?" — a narrow list shows only',
    "  its first few words. Rewrite it when the user's goal actually changes; leave it alone as work",
    "  merely progresses. Name the subject, not the process (planning, testing, merge). Plain language,",
    '  and never open with "The assistant", "Subagent", a commit hash, or a status word.',
    '  Good: "Fanout UX: dialog redesign and model-pick bug". Bad: "The round is committed as dc63576".',
    "",
    "Example. The existing outline is:",
    '[{"id":"t1","heading":"Merge blocked","summary":["Blocked by your uncommitted sidebar edits."]},',
    ' {"id":"t2","heading":"Workers after a restart","summary":["Workers come back after a restart, with their usage intact."]}]',
    "EARLIER MESSAGES:",
    "[p1] USER: commit my sidebar edits, then merge",
    "[p2] ASSISTANT: Committing your sidebar edits first.",
    "NEW MESSAGES:",
    "[m1] TOOL call: bash",
    "[m2] ASSISTANT: Merged, not pushed. Tests and build pass.",
    "[m3] USER: does resume pick up where each worker left off?",
    "[m4] TOOL call: read · resume.ts",
    "[m5] ASSISTANT: Yes, resume picks up where each worker left off. The merge is in there too.",
    "[m6] USER: ok restart",
    "[m7] ASSISTANT: Restarted. Every worker came back and resumed.",
    "A good response:",
    '{"now":"Merged, and workers resume after a restart.","overall":"Bringing workers back after a Sova restart","topicUpdates":[',
    ' {"kind":"update","topicId":"t1","heading":"Merge","from":"m1","to":"m2","summary":["Merged after you committed your sidebar edits. Not pushed.","Tests and build pass."]},',
    ' {"kind":"update","topicId":"t2","heading":"Workers after a restart","from":"m3","to":"m7","summary":["Workers come back after a restart, with their usage intact.","Resume picks up where each worker left off."]}]}',
    "Note: t1's range starts at m1: p1-p2 explain what m1-m2 finish, but only new messages are claimed. m5 mentions",
    "the merge in passing, so it stays in t2's range and the merge is not repeated there. The restart at m6-m7 serves",
    't2 and adds no new fact. t1\'s status heading became a subject and its obsolete "blocked" fact is gone; t2 resends',
    "the fact it already had.",
    "",
    "- Respond with ONLY a single JSON object, no markdown fences:",
    '{"now":"...","overall":"...","topicUpdates":[{"kind":"new"|"update","heading":"...","topicId":"t1?","from":"m3","to":"m9","summary":["..."]}]}',
    "For kind=update include the topicId of an existing topic. For kind=new provide a new heading.",
    "Only include topics the new messages changed. If nothing material changed, return {\"now\":\"...\",\"overall\":\"...\",\"topicUpdates\":[]}.",
    "",
    'SESSION ANCHOR — the earliest user request still in view. It is usually what the session is for,',
    'but it may be a mid-session message, and the user may since have moved on. Weigh it with the',
    'existing outline: when they disagree, the topics win.',
    input.purpose || "unknown",
    "",
    "EXISTING OUTLINE (JSON, ids t1..):",
    input.existingOutline || "none",
    "",
    ...(lookback.length
      ? ["EARLIER MESSAGES (already summarized, context only; their p refs are never valid in from or to):", ...lookback, ""]
      : []),
    "NEW MESSAGES:",
    ...input.newLines,
  ].join("\n");
}

/** Extract the first balanced top-level {...} JSON object from messy model output. */
export function extractJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

/** Collapse whitespace; a text over `max` ends on a word boundary with "…" (never over `max` in all).
 *  A safety net: the prompt asks for far shorter text. A single word longer than half of `max` is cut
 *  mid-word rather than dropped. */
export function clampText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  const head = text.slice(0, max - 1);
  // The head ends on a whole word when the next character is the space after it.
  const space = text[max - 1] === " " ? head.length : head.lastIndexOf(" ");
  const kept = space > max / 2 ? head.slice(0, space) : head;
  return `${kept.replace(/[\s,;:.\-–—]+$/, "")}…`;
}

/** Bullets are asked for at most 70 characters; this is the parser's ceiling above that. */
const BULLET_CHARS = 120;

/**
 * Parse and validate summarizer output. Throws SummarizerError when the envelope
 * itself is unusable (counts as a backend failure and falls through the chain).
 * Invalid individual topicUpdates are dropped, salvaging the good ones.
 */
export function parseSummarizerJson(text: string, validRefs: Set<string>): SummarizerResult {
  const cleaned = text.replace(/^\s*```(?:json)?/m, "").replace(/```\s*$/, "");
  const slice = extractJsonObject(cleaned);
  if (!slice) throw new SummarizerError("output contained no JSON object");
  let raw: unknown;
  try {
    raw = JSON.parse(slice);
  } catch {
    throw new SummarizerError("output JSON did not parse");
  }
  if (!raw || typeof raw !== "object") throw new SummarizerError("output was not an object");
  const record = raw as Record<string, unknown>;
  const now = clampText(record.now, 200);
  const overall = clampText(record.overall, 240);
  if (!now && !overall && !Array.isArray(record.topicUpdates)) {
    throw new SummarizerError("output had neither now, overall, nor topicUpdates");
  }
  const updates: SummarizerResult["topicUpdates"] = [];
  if (Array.isArray(record.topicUpdates)) {
    for (const item of record.topicUpdates.slice(0, 12)) {
      if (!item || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      const kind = entry.kind === "update" ? "update" : entry.kind === "new" ? "new" : undefined;
      const heading = clampText(entry.heading, 80);
      // The claim: from/to, or the older single anchor as both ends when the model sends no range.
      const ref = (value: unknown) => typeof value === "string" ? value.trim() : "";
      const anchor = ref(entry.anchor);
      const from = ref(entry.from) || anchor;
      const to = ref(entry.to) || from;
      if (!kind || !heading || !from || !validRefs.has(from) || !validRefs.has(to) || !claimOf(from, to)) continue;
      const summary: string[] = [];
      if (Array.isArray(entry.summary)) {
        for (const bullet of entry.summary.slice(0, 4)) {
          const line = clampText(bullet, BULLET_CHARS);
          if (line) summary.push(line);
        }
      }
      if (!summary.length) continue;
      const update: SummarizerResult["topicUpdates"][number] = { kind, heading, from, to, summary };
      const topicId = typeof entry.topicId === "string" ? entry.topicId.trim().slice(0, 24) : "";
      if (topicId) update.topicId = topicId;
      updates.push(update);
    }
  }
  return { now: now ?? "", overall: overall ?? "", topicUpdates: updates };
}

interface BackoffState {
  failures: number;
  pausedUntil: number;
}

export class SummarizerChain {
  private readonly backoff = new Map<string, BackoffState>();

  constructor(private readonly summarizers: Summarizer[]) {}

  async run(input: SummarizeInput): Promise<{ result: SummarizerResult; backend: string }> {
    const errors: string[] = [];
    for (const summarizer of this.summarizers) {
      const state = this.backoff.get(summarizer.name);
      if (state && state.pausedUntil > Date.now()) {
        errors.push(`${summarizer.name}: paused (${Math.ceil((state.pausedUntil - Date.now()) / 1000)}s backoff)`);
        continue;
      }
      try {
        const result = await summarizer.summarize(input);
        this.backoff.delete(summarizer.name);
        return { result, backend: summarizer.name };
      } catch (error) {
        const previous = this.backoff.get(summarizer.name) ?? { failures: 0, pausedUntil: 0 };
        const failures = previous.failures + 1;
        const pause = BACKOFF_STEPS_MS[Math.min(failures - 1, BACKOFF_STEPS_MS.length - 1)];
        this.backoff.set(summarizer.name, { failures, pausedUntil: Date.now() + pause });
        errors.push(`${summarizer.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new SummarizerError(`all summarizers failed — ${errors.join("; ")}`);
  }

  summarizeStatus(): string {
    const paused = [...this.backoff.entries()]
      .filter(([, state]) => state.pausedUntil > Date.now())
      .map(([name, state]) => `${name} paused ${Math.ceil((state.pausedUntil - Date.now()) / 1000)}s`);
    return paused.length ? paused.join(", ") : "";
  }
}
