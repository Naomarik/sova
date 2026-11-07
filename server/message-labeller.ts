// Labelling each message the user types (§app.message-labels/labelling), in the background: nothing waits on
// it and the agent never sees a label. What is pending is read from the transcripts each time (the user's typed
// messages since the switch went on, with no stored label), never kept, so a restart or a provider down for an hour
// costs nothing but the wait. Only the retry pacing lives in memory.

import { withUsageContext } from "../pi-config/extensions/llm-inflight/attribution.ts";
import { withoutFooter, head, tail, exclusionReason } from "./attention-signals";
import { DecisionError, type Answer, type DecisionProvider, type DecisionRequest, type Question } from "./decide";
import { MESSAGE_HEAD_CHARS, REPLY_TAIL_CHARS, type OwnMessage } from "./message-input";
import { pendingMessages } from "./time-spent-messages";
import { MESSAGE_LABELS, REAL_LABELS, type MessageLabel, type MessageLabelStore } from "./message-labels";
import type { DecisionSettings, SessionSummary } from "../shared/protocol";

/** The labels as the classifier gets them: the words of the tuned variant n4-rule, the user's own meanings. */
export const LABEL_OPTIONS: Record<MessageLabel, string> = {
  specifying:
    "Says WHAT the deliverable should be: new work of its own however small, a problem in something the agent did not make here, a requirement of work not produced yet, or taking the agent's recommendations or picks (unless purely about process).",
  directing:
    "Says HOW the agent works, with no WHAT: process steps (verify, commit, push, merge, test, measure, mock-ups, review), order, who or which model, how to report; or moves work on: a short go-ahead or approval, also one that names the thing or the tool to use, next piece, stop, picks on purely process questions.",
  reworking:
    "Rejects, changes, removes, redoes or fixes something the agent made, showed or reported in this conversation, or says it is wrong, missing or broken, in any tone, also worded as a wish or handed to another agent.",
  asking:
    "Nothing requested, chosen or approved: wants only an answer, explanation (in any form), status, opinion, or a finding from a check.",
  unsorted:
    "The message has none of the person's own words to judge. Never choose this when any of the four fits.",
};

export const LABEL_QUESTIONS: Record<string, Question> = {
  label: {
    type: "choice",
    instructions:
      "One message a person sent their coding agent. Label what the message does to the work, never its tone or mood. `message` is its start. `previous_reply_tail` is the end of the agent's reply before it: what the agent made, reported, proposed, offered or asked. `last_turn_delivered_results` says the agent's last turn changed files, showed an image or handed in a report, so there may be produced work to judge. `attaches_image` says the message carries an image, usually of that work. Sova's own pick wording (\"al_1: take your recommendation on q1… My answers: 1b — <text>\") means picking options the agent offered: the text after each pick is the option's own wording, and read the agent's questions in the previous reply to see what each pick is about. Every message gets one of the four labels: take the first that applies. 1. reworking: the message rejects, changes, removes, redoes or fixes anything the agent already made, showed, wrote or ran in this conversation (code, a screen, a page, a report, a link, a command, how it handled a worker), or says that result is wrong, missing, useless or still broken. Any change asked for in what the agent just delivered or showed is reworking, even when worded as a new idea or a wish (\"it might be nice if…\", \"we can also drop…\", \"any chance you could…\"), when it adds to that work, or when another agent is to do it; in any tone. When the last turn delivered results and the message asks to change, move, restyle, remove from, overhaul or redo the thing it points at (\"that chart\", \"it\", \"here\", \"this section\"), take it as made here: reworking, not specifying. A plain question about whether or why a result shows, with no complaint, is not reworking. 2. specifying: the message says WHAT the deliverable itself should be: its content, features, requirements or scope. That covers new work of its own, however small: a feature, a fix, a page, a setting to change, or an action on something outside the agent's own process (send a test message too, close an app). It covers a problem report about something this agent did not make in this conversation, and adding, changing or dropping a requirement of work not produced yet. It also covers taking the agent's recommendations or picking among its options (\"go with your recommendations\", \"fine\", \"2b\"): that is specifying by default, also when you cannot read the questions, and so is a bare short yes to the agent's recommendation (\"sure\", \"works for me\", \"fine\"); only when every question is purely about how the agent works (who does it, which model, how to test or land), with no feature content, is it directing. Any WHAT in the message makes it specifying, even when it also approves, says how to work, or asks a question: one clause about what the deliverable must contain, cover or leave out is enough, however much of the message is about method or staffing. Naming the thing a go-ahead is about, or the one tool or option it picks as it says to go on, is not a WHAT. 3. directing: the message says HOW the agent does its job, with no WHAT. That means steps of the process: verify, check, commit, push, merge, land, release, deploy, restart, measure, test, take screenshots, make mock-ups or a prototype to look at, plan again, review. It means their order and timing, who or which model or tool does them (a team, a subagent, a reviewer), and standing instructions for how to work or report from now on. It also means moving the work on: go-aheads and approvals of what is already decided (go, continue, proceed, fix it, do it all), approving an action the agent offered to take (kill that process, delete those files, land, merge, restart, rerun), moving on to the next planned piece of work (\"now work on the next screen\"), stopping or pausing the agent's own work, recommendations or picks on questions purely about how the agent works, handing over what the work needs (a token, a path), or asking to see the produced work itself (a link, a diff, screenshots). Naming a task only to say how it should be run is directing. A short go-ahead or approval is directing, also when it names the thing it moves on, starts with a yes to the agent's recommendation or picks one tool or option as it says to go on (a pick with no go-ahead stays specifying): \"ship it\", \"yes, sort that out\", \"go on then\", \"ok, let's make it happen\", \"get the branch queued up\", \"take option two and carry on\". Only a substantive description of what the work should be (its content, features, requirements or scope) makes it specifying; a go-ahead to work the agent offered stays directing when it only adds how carefully, fully or simply to do it. 4. asking: nothing is requested, chosen or approved. That covers a question, a request for an explanation, status, opinion or summary (also in a given form: with visuals or diagrams, as tradeoffs, simpler), a remark or view with no request, \"how can we fix X?\" or a check that it understood (\"…, right?\") with no request, and a check, test, investigation or watch whose only output is a finding for him (look into, check, research or watch X and tell me). A question attached to a request, pick or go-ahead takes that one's label instead: a go-ahead with a question is directing. Mixed messages: saying what the deliverable should be and also how to work is specifying; a go-ahead plus only HOW is directing; an investigation that also says who or how is to do it is directing. Choose unsorted only if the message has none of the person's own words to judge.",
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

/**
 * What is stored for an answer. When the top choice is "unsorted", the most likely of the four real labels is stored
 * instead (the first in REAL_LABELS' order on a tie), with its own confidence by the same measure; "unsorted" stays
 * only when the answer gave none of the four any weight.
 */
export function storedLabel(answer: Extract<Answer, { type: "choice" }>): { label: MessageLabel; confidence: number } {
  if (answer.choice !== "unsorted") return { label: answer.choice as MessageLabel, confidence: answer.confidence };
  let best: MessageLabel | null = null;
  let peak = 0;
  for (const l of REAL_LABELS) {
    const p = answer.probabilities[l] ?? 0;
    if (Number.isFinite(p) && p > peak) (best = l), (peak = p);
  }
  if (!best) return { label: "unsorted", confidence: answer.confidence };
  const n = MESSAGE_LABELS.length;
  return { label: best, confidence: Math.max(0, (n * peak - 1) / (n - 1)) };
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
      store.label(session, m.id, { ...storedLabel(answer), provider: r.provider, model: r.model, at: this.now() });
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
