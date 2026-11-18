import fs from "node:fs";
import path from "node:path";
import { USAGE_TIME_LABELS, type UsageTimeLabel } from "../../shared/usage/time";

/**
 * The usage helper's reader of message labels (`<state root>/message-labels/<session>.jsonl`, written by
 * server/message-labels.ts): each labelled message's label and when it was sent. A label line written
 * before send times were kept has none, and is placed by when it was labelled (`at`). Read without
 * transcripts: a message never labelled isn't here. A session's file is read again whenever its size
 * or mtime changes; a gone file's messages go with it.
 */

/** A label stored before the labels changed: Steering is read as Directing (server/message-labels.ts). */
const RENAMED: Record<string, UsageTimeLabel> = { steering: "directing" };
const LABELS = new Set<string>(USAGE_TIME_LABELS);
const SESSION_FILE = /^([A-Za-z0-9][A-Za-z0-9._-]*)\.jsonl$/;

export interface LabelledMessage {
  label: UsageTimeLabel;
  /** ms epoch: when it was sent, or (byLabelTime) when it was labelled. */
  t: number;
  byLabelTime: boolean;
}

const time = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** A press that sends no labelled message but closes time, as a message does (§app.message-labels/crediting):
    a Land press, or a button sending words for you. */
const ACTION_SAME_MS = 2_000;

/**
 * A session file's labelled messages, oldest first, and the actions (Land and button presses, ms) that close
 * time as a message does. The last line for an id wins, as the server reads it. A labelled message sent by a
 * button's press is that action, not a message.
 */
export function parseLabels(text: string): { messages: LabelledMessage[]; actions: number[] } {
  const by = new Map<string, LabelledMessage>();
  const program = new Set<string>();
  const actions: number[] = [];
  for (const raw of text.split("\n")) {
    if (!raw) continue;
    let l: any;
    try {
      l = JSON.parse(raw);
    } catch {
      continue;
    }
    if (time(l?.land)) actions.push(l.land);
    if (typeof l?.acted === "string" && time(l.at)) actions.push(l.at);
    if (typeof l?.id !== "string") continue;
    if (l.program === true) program.add(l.id);
    const label = typeof l.label === "string" ? (RENAMED[l.label] ?? l.label) : undefined;
    if (!LABELS.has(label) || typeof l.confidence !== "number") continue;
    const sent = time(l.sentAt);
    const t = sent ? l.sentAt : time(l.at) ? l.at : null;
    if (t === null) continue;
    by.set(l.id, { label, t, byLabelTime: !sent });
  }
  for (const id of program) by.delete(id);
  actions.sort((a, b) => a - b);
  const messages = [...by.values()].filter((m) => m.byLabelTime || !actions.some((a) => Math.abs(a - m.t) <= ACTION_SAME_MS)).sort((a, b) => a.t - b.t);
  return { messages, actions };
}

export class LabelStore {
  private readonly files = new Map<string, { size: number; mtimeMs: number; messages: LabelledMessage[]; actions: number[] }>();
  private seq = 0;

  constructor(private readonly dir: string) {}

  get version(): number {
    return this.seq;
  }

  sessions(): ReadonlyMap<string, { messages: readonly LabelledMessage[]; actions: readonly number[] }> {
    return this.files;
  }

  /** The first message whose send time was kept (ms), or null. */
  firstSent(): number | null {
    let first: number | null = null;
    for (const f of this.files.values()) for (const m of f.messages) if (!m.byLabelTime && (first === null || m.t < first)) first = m.t;
    return first;
  }

  refresh(): void {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      names = [];
    }
    const seen = new Set<string>();
    for (const name of names) {
      const m = SESSION_FILE.exec(name);
      if (!m || name === "switch.jsonl") continue;
      const sid = m[1]!;
      const file = path.join(this.dir, name);
      let st: fs.Stats;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      seen.add(sid);
      const had = this.files.get(sid);
      if (had && had.size === st.size && had.mtimeMs === st.mtimeMs) continue;
      try {
        this.files.set(sid, { size: st.size, mtimeMs: st.mtimeMs, ...parseLabels(fs.readFileSync(file, "utf8")) });
        this.seq++;
      } catch { /* tried again on its next change */ }
    }
    for (const sid of [...this.files.keys()]) {
      if (seen.has(sid)) continue;
      this.files.delete(sid);
      this.seq++;
    }
  }
}
