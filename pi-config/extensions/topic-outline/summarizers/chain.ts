/**
 * Chain of summarizer backends with per-backend backoff, plus the shared
 * prompt builder and defensive JSON parser used by every backend.
 */

import type { Summarizer, SummarizeInput, SummarizerResult } from "../types.ts";
import { SummarizerError } from "../types.ts";

const BACKOFF_STEPS_MS = [60_000, 300_000, 900_000];

export function buildPrompt(input: SummarizeInput): string {
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
    "Bullets:",
    "- 1-2 bullets per topic, each at most 70 characters, one fact each, in plain words, not needlessly technical.",
    "- For kind=update, send the COMPLETE summary for that topic: your bullets replace the stored ones, and your heading",
    "  replaces the stored heading. Resend the earlier facts that still matter, drop what the new messages made",
    "  obsolete, and add what is new.",
    "- Say what was decided, done or found, never the steps taken to get there. No check times.",
    '- Address the user as "you". Never open with "User asked", "The user", "The assistant" or "Assistant".',
    "- Leave out commit hashes, file and function names, worker ids, and internal names, unless the user typed them.",
    "- Leave out open items, to-dos, next steps and anything still open: the chat is ongoing, and the topics record",
    "  outcomes only.",
    "- Only facts the messages state. Never infer a regression, a problem, a cause or a result they don't state.",
    "- Never include secrets, tokens, keys, or commands verbatim.",
    '- "anchor" must be one of the provided message refs (like "m12") where the topic was started or last advanced.',
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
    ' {"id":"t2","heading":"Model names","summary":["Claude workers show the same model name everywhere."]},',
    ' {"id":"t3","heading":"Workers after a restart","summary":["Workers come back after a restart, with their usage intact."]}]',
    "The new messages say you committed the sidebar edits, the merge landed unpushed, tests and build pass, resume",
    "picks up where each worker left off, Claude Code chats that failed to start after a restart are fixed, the",
    "sandbox menu was missing because of an old build and a rebuild fixed it, and the install is done. A good response:",
    '{"now":"Merged and installed. Restart Sova when you\'re ready.","overall":"Bringing workers back after a Sova restart","topicUpdates":[',
    ' {"kind":"update","topicId":"t1","heading":"Merge","anchor":"m14","summary":["Merged after you committed your sidebar edits. Not pushed.","Tests and build pass."]},',
    ' {"kind":"update","topicId":"t3","heading":"Workers after a restart","anchor":"m16","summary":["Workers come back after a restart, with their usage intact.","Resume picks up where each worker left off."]},',
    ' {"kind":"new","heading":"Chat after a restart","anchor":"m18","summary":["Claude Code chats failed to start after a restart. Fixed."]},',
    ' {"kind":"new","heading":"Sandbox menu","anchor":"m20","summary":["It was missing because of an old build. A rebuild fixed it."]}]}',
    'Note: t1\'s status heading became a subject and its obsolete "blocked" fact is gone; t3 resends the fact it',
    "already had; t2 is unchanged, so it is left out.",
    "",
    "- Respond with ONLY a single JSON object, no markdown fences:",
    '{"now":"...","overall":"...","topicUpdates":[{"kind":"new"|"update","heading":"...","topicId":"t1?","anchor":"m12","summary":["..."]}]}',
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
      const anchor = typeof entry.anchor === "string" ? entry.anchor.trim() : "";
      if (!kind || !heading || !anchor || !validRefs.has(anchor)) continue;
      const summary: string[] = [];
      if (Array.isArray(entry.summary)) {
        for (const bullet of entry.summary.slice(0, 4)) {
          const line = clampText(bullet, BULLET_CHARS);
          if (line) summary.push(line);
        }
      }
      if (!summary.length) continue;
      const update: SummarizerResult["topicUpdates"][number] = { kind, heading, anchor, summary };
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
