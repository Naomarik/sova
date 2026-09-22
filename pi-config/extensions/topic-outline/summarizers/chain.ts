/**
 * Chain of summarizer backends with per-backend backoff, plus the shared
 * prompt builder and defensive JSON parser used by every backend.
 */

import type { Summarizer, SummarizeInput, SummarizerResult } from "../types.ts";
import { SummarizerError } from "../types.ts";

const BACKOFF_STEPS_MS = [60_000, 300_000, 900_000];

export function buildPrompt(input: SummarizeInput): string {
  return [
    "You maintain a live topical outline of a coding-agent conversation between USER and ASSISTANT.",
    "You are shown the existing outline and only the newest messages. Update the outline incrementally.",
    "Rules:",
    "- Group work into topics with short headings (3-7 words).",
    "- A topic is one concern the user raised; add a new visit when an existing topic is raised again.",
    "- Each visit summary: 1-3 short bullets about what the assistant did or concluded, in plain language.",
    "- Mention important file basenames; never include secrets, tokens, or commands verbatim.",
    '- "anchor" must be one of the provided message refs (like "m12") where the topic was started or last advanced.',
    "- Never invent refs or topics outside the provided messages.",
    '- "now": one sentence describing what the assistant is working on NOW, based on the latest messages.',
    '- "overall": what this session is FOR, at most 14 words, starting with its subject.',
    '  Answer "what is this session about?", never "what just happened?" — a narrow list shows only',
    "  its first few words. Rewrite it when the user's goal actually changes; leave it alone as work",
    '  merely progresses. Plain language, and never open with "The assistant", "Subagent", a commit',
    '  hash, or a status word.',
    '  Good: "Fanout UX: dialog redesign and model-pick bug". Bad: "The round is committed as dc63576".',
    "- Respond with ONLY a single JSON object, no markdown fences:",
    '{"now":"...","overall":"...","topicUpdates":[{"kind":"new"|"update","heading":"...","topicId":"t1?","anchor":"m12","summary":["..."]}]}',
    "For kind=update include topicId of an existing topic. For kind=new provide a new heading.",
    "If nothing material changed, return {\"now\":\"...\",\"overall\":\"...\",\"topicUpdates\":[]}.",
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

function clampText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

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
          const line = clampText(bullet, 240);
          if (line) summary.push(line);
        }
      }
      if (!summary.length) continue;
      const update: SummarizerResult["topicUpdates"][number] = { kind, heading, anchor, summary };
      const topicId = clampText(entry.topicId, 24);
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
