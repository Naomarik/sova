// A playbook that requires an alignment first (its `align` questions): /name opens the card as a draft marked
// aligning, which no page draws yet; the chat is asked to open an ordinary alignment with those questions (align
// turned on in it if off), each question's topic its id. Once the person confirms it (every question decided), each
// decision fills the chat-worked choice its question names, marked From your alignment, and the card is drawn where
// the chat now is. A dropped alignment draws the card with those choices empty. Alignments are only read, with the
// align extension's own fold (server/align-state.ts alignDocsIn); nothing here writes or changes one.
import { alignStatus, type AlignDocument } from "../../pi-config/extensions/mode/align.ts";
import type { HEntry } from "../../shared/harness";
import type { PlaybookSpec } from "../../shared/playbook-format";
import type { ChatModePatch } from "../../shared/chat-runtime";
import { alignDocsIn } from "../align-state";
import { loadPlaybook } from "./env";
import { changeRun, runById, runsOfChat, type PlaybookRunRecord } from "./store";

/** What this reaches a chat through (start.ts's own seam, in part); tests stand in for it. */
export interface AlignFirstHost {
  chat(path: string): Promise<{ readonly mirror: { mode: { mode: string; minorModes: readonly string[] } }; switchMode(patch: ChatModePatch): Promise<unknown>; branch(): Promise<readonly HEntry[]> }>;
  prompt(path: string, text: string): Promise<{ ok: true } | { ok: false; error: string }>;
  preflight(path: string): Promise<string | null>;
}

/** What the chat is asked: the alignment to open, its questions, and what happens on confirm. */
export function alignMessage(r: Pick<PlaybookRunRecord, "id" | "text" | "playbook">, spec: PlaybookSpec): string {
  const qs = spec.align?.questions ?? [];
  return [
    `Before the card of the playbook "${r.playbook.title}" (run ${r.id}): this playbook starts with an alignment. Open one now with the align tool, with these questions in this order, each question's topic exactly its id; recommend an answer to each from what the person asked.`,
    ...qs.map((q) => `- ${q.id}: ${q.ask}`),
    ...(r.text ? [`The person's words with the playbook: ${r.text}`] : []),
    "Once the person has decided every question, Sova fills the card from the decisions and shows it; don't fill its choices yourself and don't start anything. If the alignment is dropped, the card shows with those choices for you to work out with the person.",
  ].join("\n");
}

/** Ask the chat to align first: align on if it's off, then the message. Why it couldn't, or null. */
export async function beginAlignment(r: PlaybookRunRecord, spec: PlaybookSpec, host: AlignFirstHost): Promise<string | null> {
  const path = r.shownIn?.path;
  if (!path) return "No chat shows the card.";
  const refused = await host.preflight(path);
  if (refused) return refused;
  const chat = await host.chat(path);
  const minors = chat.mirror.mode.minorModes;
  if (!minors.includes("align")) await chat.switchMode({ minorModes: [...minors, "align"] as ChatModePatch["minorModes"] });
  const sent = await host.prompt(path, alignMessage(r, spec));
  return sent.ok ? null : sent.error;
}

/** The card is drawn from here on: no longer aligning, standing where the chat is now. */
function draw(r: PlaybookRunRecord, fill?: Record<string, unknown>): void {
  changeRun(r.id, (x) => {
    delete x.aligning;
    if (fill) for (const [id, v] of Object.entries(fill)) {
      x.initial.choices[id] = v;
      x.initial.origins[id] = "alignment";
    }
    x.anchor = { at: new Date().toISOString() };
    x.revision++;
  });
}

/** Stop waiting on an alignment the chat can't be asked to open: the card shows now, those choices empty. */
export const abandonAlignment = (r: PlaybookRunRecord): void => draw(r);

/** The alignment this run waits on: the newest opened since it began whose questions carry its questions' ids. */
export function alignmentOf(docs: readonly AlignDocument[], since: string, spec: PlaybookSpec): AlignDocument | undefined {
  const ids = new Set((spec.align?.questions ?? []).map((q) => q.id));
  return [...docs].reverse().find((d) => d.createdAt >= since && d.questions.some((q) => ids.has(q.topic.trim())));
}

/** A decision as the value of the choice it fills: a list takes one item per line or per "; " (a decision is kept on one line). */
const valueOf = (text: string, type: string): unknown =>
  type === "list" ? text.split(/\n|;\s+/).map((l) => l.replace(/^\s*(?:[-*]|\d+\.)\s+/, "").trim()).filter(Boolean) : text.trim();

/** Look at the chat's alignments for one aligning run: confirmed fills and draws it, dropped draws it empty. True when it was drawn. */
export async function settleAlignment(runId: string, host: Pick<AlignFirstHost, "chat">): Promise<boolean> {
  const r = runById(runId);
  if (!r?.aligning || r.state !== "draft" || r.closed || !r.shownIn) return false;
  const spec = (await loadPlaybook(r.playbook, r.cwd).catch(() => null))?.spec;
  if (!spec?.align) {
    draw(r);
    return true;
  }
  const doc = alignmentOf(alignDocsIn(await (await host.chat(r.shownIn.path)).branch()), r.aligning.since, spec);
  if (!doc) return false;
  const status = alignStatus(doc);
  if (status === "dropped") {
    draw(r);
    return true;
  }
  if (status === "aligning") return false;
  const fill: Record<string, unknown> = {};
  for (const q of spec.align.questions) {
    if (!q.fills) continue;
    const decided = doc.questions.find((x) => x.topic.trim() === q.id && !x.dropped)?.decision;
    const input = spec.inputs.find((i) => i.id === q.fills);
    if (decided && input) fill[q.fills] = valueOf(decided.text, input.type);
  }
  draw(r, fill);
  return true;
}

/** Every aligning card a chat shows, looked at once its turn settles. */
export async function settleChat(sessionId: string, host: Pick<AlignFirstHost, "chat">): Promise<void> {
  for (const r of runsOfChat(sessionId)) if (r.aligning) await settleAlignment(r.id, host).catch((err) => console.warn(`[playbook-runs] ${r.id}: its alignment wasn't read: ${err instanceof Error ? err.message : String(err)}`));
}
