import type { ToolSpec } from "../shared/harness";
import type { PairView, SessionSummary } from "../shared/protocol";
import type { ToolCall } from "./overseer-idea-tools";
import { jobText, PAIR_ID_RE, PairError, pairIntro, pairRefusal, pairView, resumePairing, unpair } from "./topic-pairs";
import type { PairRecord } from "./topic-store";
import { endPairing, topicStore } from "./topics";

/**
 * The Overseer's `sova_pair` (§app.overseer/pairs): `pair`, `unpair` and `resume` are acts (audited,
 * refused in a turn the user did not start unless an approval for later or a standing rule covers
 * both chats; no confirm card), `list` is a read. Pairing changes neither chat's tools or prompt:
 * each gets a topic only its partner may push to, and one introduction sent as the Overseer's
 * other messages are (the prompt route, so the row carries the Overseer's tag).
 */

type Out = { content: { type: "text"; text: string }[]; details: unknown };
type Tool = ToolSpec;

/** What a sova_pair result's details are: the pairing drawn on its action card. */
export interface PairToolDetails {
  v: 1;
  op: "pair" | "unpair" | "resume";
  pair: PairView;
  existing?: true;
}

export interface PairToolDeps {
  act(name: string, run: (params: any, toolCallId: string, call: ToolCall) => Promise<Out>): Tool["execute"];
  read(run: (params: any, call: ToolCall & { toolCallId: string }) => Promise<Out>): Tool["execute"];
  /** A session by any form the tools print its id in (or its alias); null when none. */
  lookup(ref: unknown): Promise<SessionSummary | null>;
  /** Send the introduction as the Overseer's message: idle it starts a turn, busy it waits as a follow-up. */
  send(s: SessionSummary, text: string): Promise<void>;
  /** Take `n` prompts from the per-turn cap, or the refusal sentence (nothing taken then). */
  take(n: number): string | null;
  give(n: number): void;
  refusal(message: string): Error;
  obj(properties: Record<string, unknown>, required?: string[]): any;
  str(description: string, extra?: Record<string, unknown>): unknown;
}

const text = (t: string) => [{ type: "text" as const, text: t }];
const JOB_MAX = 600;

/** The two chats a pairing act names, for the approvals check: `a` and `b`, or a pairing's two. */
export function pairTargets(params: any): string[] | null {
  const op = params?.op;
  if (op === "pair") return typeof params?.a === "string" && typeof params?.b === "string" ? [params.a, params.b] : null;
  if (op === "unpair" || op === "resume") {
    const p = typeof params?.pairing === "string" ? topicStore().pair(params.pairing.trim()) : null;
    return p ? [p.a.sessionId, p.b.sessionId] : null;
  }
  return null;
}

export function pairTools(d: PairToolDeps): Tool[] {
  const { obj, str } = d;
  const titles = async (p: PairRecord): Promise<(id: string) => string | undefined> => {
    const m = new Map<string, string>();
    for (const id of [p.a.sessionId, p.b.sessionId]) {
      const s = await d.lookup(id).catch(() => null);
      if (s) m.set(id, s.title);
    }
    return (id) => m.get(id);
  };
  const line = (v: PairView) =>
    `- ${v.id}: [${v.a.title.replace(/[[\]]/g, "")}](sova://s/${v.a.sessionId}) (topic ${v.a.topic}, ${v.a.notesIn}/${v.limit} notes in${v.a.paused ? ", PAUSED" : ""}) ↔ [${v.b.title.replace(/[[\]]/g, "")}](sova://s/${v.b.sessionId}) (topic ${v.b.topic}, ${v.b.notesIn}/${v.limit} notes in${v.b.paused ? ", PAUSED" : ""})`;
  const pairingId = (p: any): string => {
    const id = typeof p?.pairing === "string" ? p.pairing.trim() : "";
    if (!PAIR_ID_RE.test(id)) throw d.refusal("Name the pairing by its id (pr_ and 12 hex digits, from sova_pair list).");
    return id;
  };
  const pairError = (f: () => PairRecord): PairRecord => {
    try {
      return f();
    } catch (err) {
      if (err instanceof PairError) throw d.refusal(err.message);
      throw err;
    }
  };

  async function pair(p: any): Promise<Out> {
    if (typeof p.host === "string" && p.host.trim()) throw d.refusal("Pairing is for two chats on this host; a chat on another host can't be paired. Nothing was changed.");
    const jobA = jobText(p.job_a);
    const jobB = jobText(p.job_b);
    if (!jobA || !jobB) throw d.refusal("Say each chat's job: job_a what a does (b is told it), job_b what b does (a is told it). Nothing was changed.");
    if (jobA.length > JOB_MAX || jobB.length > JOB_MAX) throw d.refusal(`Keep each job to ${JOB_MAX} characters. Nothing was changed.`);
    const sides: SessionSummary[] = [];
    for (const ref of [p.a, p.b]) {
      const s = await d.lookup(ref);
      if (!s) throw d.refusal(`No session with id ${String(ref ?? "")} on this host (a chat on another host can't be paired). Nothing was changed.`);
      sides.push(s);
    }
    const [a, b] = sides as [SessionSummary, SessionSummary];
    if (a.id === b.id) throw d.refusal(`a and b are the same chat, "${a.title}"; a pairing joins two different chats. Nothing was changed.`);
    for (const s of [a, b]) {
      const why = pairRefusal(s);
      if (why) throw d.refusal(why);
    }
    const s = topicStore();
    const had = s.pairOf(a.id, b.id);
    if (had) {
      const v = pairView(had, await titles(had));
      return { content: text(`"${a.title}" and "${b.title}" are already paired as ${had.id}; nothing changed.\n${line(v)}`), details: { v: 1, op: "pair", pair: v, existing: true } satisfies PairToolDetails };
    }
    const over = d.take(2);
    if (over) throw d.refusal(over);
    let made: PairRecord;
    try {
      made = s.openPair({ sessionId: a.id, path: a.path, job: jobA }, { sessionId: b.id, path: b.path, job: jobB }).pair;
    } catch (err) {
      d.give(2);
      throw d.refusal(err instanceof Error ? err.message.replace(/Session (\S+)/, (_m, id) => `"${id === a.id ? a.title : b.title}" (${id})`) : String(err));
    }
    for (const side of ["a", "b"] as const) s.audit({ sessionId: made[side].sessionId, tool: "sova_pair", topic: made[side].topic, outcome: "invited", target: (side === "a" ? made.b : made.a).sessionId, pairing: made.id });
    // The introductions. One that can't be sent ends the pairing: never a half-made one.
    const told: string[] = [];
    for (const [mine, me, other] of [["a", a, b], ["b", b, a]] as const) {
      try {
        await d.send(me, pairIntro(made, mine, other.title));
        told.push(me.title);
      } catch (err) {
        endPairing(made.id, "unpaired");
        const why = err instanceof Error ? err.message : String(err);
        throw d.refusal(
          `The introduction to "${me.title}" was not sent (${why}), so the pairing was ended.${told.length ? ` "${told[0]}" already got its introduction; tell it the pairing is off if it matters.` : " Nothing was sent."}`,
        );
      }
    }
    const v = pairView(made, (id) => (id === a.id ? a.title : id === b.id ? b.title : undefined));
    return {
      content: text(`Paired "${a.title}" and "${b.title}" as ${made.id}. Each was sent its introduction: who its partner is, the partner's job, and the topic to queue_push to.\n${line(v)}`),
      details: { v: 1, op: "pair", pair: v } satisfies PairToolDetails,
    };
  }

  const actExec = d.act("sova_pair", async (p) => {
    const op = p?.op;
    if (op === "pair") return pair(p);
    if (op === "unpair") {
      const ended = pairError(() => unpair(pairingId(p)));
      const v = pairView(ended, await titles(ended));
      return { content: text(`Ended ${ended.id}: both topics closed and their waiting notes were dropped. Neither chat was told.\n${line(v)}`), details: { v: 1, op: "unpair", pair: v } satisfies PairToolDetails };
    }
    if (op === "resume") {
      const r = pairError(() => resumePairing(pairingId(p), p.direction));
      const v = pairView(r, await titles(r));
      const which = p.direction === "a_to_b" ? "a → b" : p.direction === "b_to_a" ? "b → a" : "both directions";
      return { content: text(`Resumed ${r.id} (${which}): its note count is back to 0.\n${line(v)}`), details: { v: 1, op: "resume", pair: v } satisfies PairToolDetails };
    }
    throw d.refusal('op is "pair", "unpair", "resume" or "list".');
  });
  const listExec = d.read(async (p) => {
    const ref = p?.session;
    let only: string | undefined;
    if (ref !== undefined && ref !== null && ref !== "") {
      const s = await d.lookup(ref);
      if (!s) throw d.refusal(`No session with id ${String(ref)}.`);
      only = s.id;
    }
    const views: PairView[] = [];
    for (const pr of topicStore().livePairs(only)) views.push(pairView(pr, await titles(pr)));
    const head = `${views.length} pairing${views.length === 1 ? "" : "s"} in force${only ? " for that chat" : ""}.`;
    return { content: text(views.length ? [head, ...views.map(line)].join("\n") : `${head} Pair two chats with op "pair".`), details: { count: views.length, ids: views.map((v) => v.id) } };
  });

  return [
    {
      name: "sova_pair",
      label: "Pair chats",
      // Its card reads the recorded result (EAGER_TOOLS): never a call another tool made.
      exposure: "model-only",
      description:
        "Pair two chats on this host so they can work together: each may send the other short notes with queue_push (a tool every ordinary chat already has), which arrive between turns as a queue batch. Neither chat gains or loses a tool, and its system prompt is unchanged. " +
        "op pair {a, b, job_a, job_b}: job_a says in your words what a does (b is told it), job_b what b does (a is told it); each chat gets one introduction from you naming its partner, the partner's job, and the topic to push to. Pairing the same two again returns the existing pairing. " +
        "Refused for a terminal-owned, archived, subagent, baton, project-overseer or other organization session, your own, a chat on another host, the same chat twice, or a chat already holding 10 topics. " +
        "40 notes each way, then that direction pauses until resumed. op unpair {pairing} ends it (both topics close, neither chat is told); op resume {pairing, direction?} lifts a pause; op list {session?} lists pairings in force. " +
        "pair, unpair and resume are acts: only in a turn the user started, or under an approval for later or a standing rule that covers both chats. Pair only on the user's word.",
      promptSnippet: "pair two chats on this host so they can send each other notes between turns",
      parameters: obj(
        {
          op: str("pair, unpair, resume or list.", { enum: ["pair", "unpair", "resume", "list"] }),
          a: str("pair: the first chat's session id."),
          b: str("pair: the second chat's session id."),
          job_a: str("pair: what a does, in your words (told to b)."),
          job_b: str("pair: what b does, in your words (told to a)."),
          pairing: str("unpair, resume: the pairing id (pr_…, from list)."),
          direction: str("resume: a_to_b or b_to_a; both when left out.", { enum: ["a_to_b", "b_to_a"] }),
          session: str("list: only this chat's pairings."),
        },
        ["op"],
      ),
      execute: ((toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown) =>
        params?.op === "list" ? (listExec as any)(toolCallId, params, signal, onUpdate, ctx) : (actExec as any)(toolCallId, params, signal, onUpdate, ctx)) as Tool["execute"],
    },
  ];
}
