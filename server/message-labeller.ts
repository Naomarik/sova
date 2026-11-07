// Labelling each message the user types (§app.message-labels/labelling), in the background: nothing waits on
// it and the agent never sees a label. What is pending is read from the transcripts each time (the user's typed
// messages since the switch went on, with no stored label), never kept, so a restart or a provider down for an hour
// costs nothing but the wait. Only the retry pacing lives in memory.

import { withUsageContext } from "../pi-config/extensions/llm-inflight/attribution.ts";
import { withoutFooter, head, tail, exclusionReason } from "./attention-signals";
import { DecisionError, type Answer, type DecisionProvider, type DecisionRequest, type Question } from "./decide";
import { MESSAGE_HEAD_CHARS, REPLY_TAIL_CHARS, type OwnMessage } from "./message-input";
import { pendingMessages } from "./time-spent-messages";
import { MESSAGE_LABELS, type MessageLabel, type MessageLabelStore } from "./message-labels";
import type { DecisionSettings, SessionSummary } from "../shared/protocol";

/** The labels as the classifier gets them; the words are the user's own definitions. */
export const LABEL_OPTIONS: Record<MessageLabel, string> = {
  directing: "Starts new work or moves it forward with no change: approvals, picking offered options, asking to see results.",
  steering: "Changes or adds to a plan or requirement for work the agent hasn't produced yet.",
  reworking: "Rejects or changes work the agent has already produced, in any tone, however polite or tentative.",
  asking: "Wants only an answer or explanation, with no change requested.",
  unsorted: "It changes something, but you can't tell whether the target is a plan or work already produced. Choose this rather than guess.",
};

export const LABEL_QUESTIONS: Record<string, Question> = {
  label: {
    type: "choice",
    instructions:
      "One message a person sent their coding agent. Label what the message does. `message` is its start. `previous_reply_tail` is the end of the agent's reply before it. `last_turn_delivered_results` says the agent's last turn changed files, showed an image or handed in a worker's report: work exists to be judged. `attaches_image` says the message carries an image, usually of that work. " +
      "Rule: if a message adds or changes any requirement beyond picking an offered option, label it by the change's target (a plan: steering; work already produced: reworking); only pure approvals or picks are directing. If the target is unclear, choose unsorted; never guess.",
    options: LABEL_OPTIONS,
  },
};

/** What one message is asked with. Redacted and capped by the decision layer, like every request. */
export function labelRequest(sessionId: string, m: OwnMessage): DecisionRequest {
  return {
    purpose: "message-label",
    dedupeKey: `message-label:${sessionId}:${m.id}`,
    questions: LABEL_QUESTIONS,
    state: {
      message: head(m.text, MESSAGE_HEAD_CHARS),
      previous_reply_tail: tail(withoutFooter(m.previousReply), REPLY_TAIL_CHARS),
      last_turn_delivered_results: m.delivered,
      attaches_image: m.image,
    },
  };
}

const TICK_MS = 10_000;
/** Decisions per pass, and files read: a long-off switch turned on catches up over a few passes, not at once. */
const TICK_BUDGET = 6;
const READ_BUDGET = 8;
/** After a failed ask, in order; the chain's own backing off keeps a dead provider from being called meanwhile. */
const RETRY_MS = [60_000, 5 * 60_000, 15 * 60_000] as const;

export interface LabellerDeps {
  settings: () => DecisionSettings;
  /** The decision chain; null while it has no provider at all. */
  provider: () => DecisionProvider | null;
  list: () => Promise<SessionSummary[]>;
  /** This server holds a runtime for it. */
  held: (path: string) => boolean;
  /** The session's own messages, read from its file. */
  read: (path: string) => Promise<OwnMessage[]>;
  store: () => MessageLabelStore;
  now?: () => number;
  home?: string;
}

export class MessageLabeller {
  /** Per session: the file's stamp when read, and what was pending in it. */
  private readonly seen = new Map<string, { stamp: string; pending: OwnMessage[] }>();
  /** Per message: when to ask again. `Infinity`: the request itself is wrong, Sova's own bug; not until a restart. */
  private readonly retry = new Map<string, { at: number; tries: number }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  constructor(private readonly d: LabellerDeps) {}

  private now = () => (this.d.now ?? Date.now)();

  start(intervalMs = TICK_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch((err) => console.warn("[message-labels]", err instanceof Error ? err.message : String(err))), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass. Returns how many messages it labelled. */
  async tick(): Promise<number> {
    if (this.ticking) return 0;
    const settings = this.d.settings();
    const store = this.d.store();
    const on = settings.features.messageLabels === true;
    store.noteSwitch(on, this.now());
    if (!on) {
      this.seen.clear();
      return 0;
    }
    const periods = store.periods();
    const since = periods[0]?.from;
    const provider = this.d.provider();
    if (since === undefined || !provider) return 0;
    this.ticking = true;
    try {
      let reads = READ_BUDGET;
      let budget = TICK_BUDGET;
      let done = 0;
      for (const s of await this.d.list()) {
        if (budget <= 0) break;
        const active = Date.parse(s.lastActiveAt);
        if (Number.isFinite(active) && active < since) continue;
        if (this.barred(s)) continue;
        let seen = this.seen.get(s.path);
        if (seen?.stamp !== s.lastActiveAt) {
          if (reads-- <= 0) continue;
          seen = { stamp: s.lastActiveAt, pending: pendingMessages(await this.d.read(s.path), store.read(s.id), periods) };
          this.seen.set(s.path, seen);
        }
        for (const m of [...seen.pending]) {
          if (budget <= 0) break;
          const key = `${s.id}:${m.id}`;
          const wait = this.retry.get(key);
          if (wait && wait.at > this.now()) continue;
          // Noted just after its entry was written: a read in between took it for typed.
          if (store.read(s.id).program.has(m.id)) {
            seen.pending.splice(seen.pending.indexOf(m), 1);
            continue;
          }
          // The switch or the session's eligibility may have changed during the last call: nothing more goes out.
          if (this.barred(s)) break;
          budget--;
          if (await this.ask(s, m, key, provider, store)) {
            seen.pending.splice(seen.pending.indexOf(m), 1);
            done++;
          }
        }
      }
      return done;
    } finally {
      this.ticking = false;
    }
  }

  /** The Decisions gate on the settings as they are now, never as a pass began. */
  private barred(s: SessionSummary): boolean {
    return !!exclusionReason(s, this.d.settings(), this.d.held(s.path), this.d.home, "messageLabels");
  }

  private async ask(s: SessionSummary, m: OwnMessage, key: string, provider: DecisionProvider, store: MessageLabelStore): Promise<boolean> {
    const session = s.id;
    try {
      // The usage ledger: this decision is the session's one-shot.
      const r = await withUsageContext({ owner: session, cwd: s.cwd, kind: "oneshot" }, () => provider.decide(labelRequest(session, m)));
      // The switch or the session's eligibility may have changed while the call ran: then the answer is dropped, and the
      // message stays owed if it is ever allowed again.
      if (this.barred(s)) return false;
      const answer = r.answers.label as Extract<Answer, { type: "choice" }> | undefined;
      if (answer?.type !== "choice" || !(MESSAGE_LABELS as readonly string[]).includes(answer.choice)) throw new DecisionError("malformed-answer", "no label in the answer");
      store.label(session, m.id, { label: answer.choice as MessageLabel, confidence: answer.confidence, provider: r.provider, model: r.model, at: this.now() });
      this.retry.delete(key);
      return true;
    } catch (err) {
      const failure = err instanceof DecisionError ? err.failure : "server";
      const tries = (this.retry.get(key)?.tries ?? 0) + 1;
      this.retry.set(key, { tries, at: failure === "bad-request" ? Infinity : this.now() + RETRY_MS[Math.min(tries, RETRY_MS.length) - 1]! });
      console.warn(`[message-labels] ${key}: ${failure}`);
      return false;
    }
  }
}
