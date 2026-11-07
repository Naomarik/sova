// Message labels beside the session (§app.message-labels/labelling): one append-only file per session under
// <state root>/message-labels/, never in the session's own file. It holds the classifier's answers, when a message that
// waited in the queue was pressed, and when Land was pressed. What is still unlabelled is never stored: it is read from
// the transcript, so a restart loses nothing.

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { readDecisionSettings } from "./decide-settings";
import { chatStateRoot } from "./state-root";

export const MESSAGE_LABELS = ["specifying", "directing", "reworking", "asking", "unsorted"] as const;
export type MessageLabel = (typeof MESSAGE_LABELS)[number];
/** The four a message is sorted into; "unsorted" is stored only when the answer gave none of them any weight. */
export const REAL_LABELS = ["specifying", "directing", "reworking", "asking"] as const satisfies readonly MessageLabel[];

/** A label stored before the labels changed: Steering is read as Directing. Only test copies hold one. */
const RENAMED: Record<string, MessageLabel> = { steering: "directing" };

/**
 * Below this confidence a label reads as Unsorted. Applied when read, so moving it re-classifies nothing. 0: every
 * message keeps the label stored for it.
 */
export const UNSORTED_BELOW = 0;

export interface StoredLabel {
  label: MessageLabel;
  confidence: number;
  /** Who answered: the chain's provider id and its model. */
  provider: string;
  model: string;
  at: number;
}

export interface SessionLabels {
  labels: Map<string, StoredLabel>;
  /** Entry id to when it was pressed (ms), for a message that waited in the queue. */
  presses: Map<string, number>;
  /** When Land was pressed for this session's branch (ms). */
  lands: number[];
  /** A button whose words the server sent (an offer's answer): their hash and the press. The words stay in the session's file. */
  acted: { hash: string; at: number }[];
  /** Messages no person sent, by entry id (a tour's notice, a release step, a script's prompt): neither labelled nor counted. */
  program: Set<string>;
}

export const wordsHash = (text: string): string => createHash("sha256").update(text.trim()).digest("hex").slice(0, 32);

export interface SwitchPeriod {
  from: number;
  to: number | null;
}

export const isOnAt = (periods: readonly SwitchPeriod[], at: number): boolean => periods.some((p) => at >= p.from && (p.to === null || at < p.to));

const safeId = (id: string) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id);
const isLabel = (v: unknown): v is MessageLabel => (MESSAGE_LABELS as readonly unknown[]).includes(v);
const time = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export class MessageLabelStore {
  constructor(readonly dir: string) {}

  private file(session: string): string {
    return join(this.dir, `${session}.jsonl`);
  }

  private append(session: string, line: object): void {
    if (!safeId(session)) return;
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(this.file(session), `${JSON.stringify(line)}\n`);
  }

  /** A line that can't be read (a torn write) counts for nothing: its message is asked again. */
  read(session: string): SessionLabels {
    const out: SessionLabels = { labels: new Map(), presses: new Map(), lands: [], acted: [], program: new Set() };
    if (!safeId(session)) return out;
    let text: string;
    try {
      text = readFileSync(this.file(session), "utf8");
    } catch {
      return out;
    }
    for (const raw of text.split("\n")) {
      if (!raw) continue;
      let l: any;
      try {
        l = JSON.parse(raw);
      } catch {
        continue;
      }
      const label = typeof l?.label === "string" ? (RENAMED[l.label] ?? l.label) : undefined;
      if (typeof l?.id === "string" && isLabel(label) && time(l.confidence))
        out.labels.set(l.id, { label, confidence: l.confidence, provider: String(l.provider ?? ""), model: String(l.model ?? ""), at: time(l.at) ? l.at : 0 });
      else if (typeof l?.id === "string" && time(l.pressedAt)) out.presses.set(l.id, l.pressedAt);
      else if (typeof l?.id === "string" && l.program === true) out.program.add(l.id);
      else if (time(l?.land)) out.lands.push(l.land);
      else if (typeof l?.acted === "string" && time(l.at)) out.acted.push({ hash: l.acted, at: l.at });
    }
    return out;
  }

  label(session: string, id: string, label: StoredLabel): void {
    this.append(session, { id, ...label });
  }

  press(session: string, id: string, pressedAt: number): void {
    this.append(session, { id, pressedAt });
  }

  program(session: string, id: string): void {
    this.append(session, { id, program: true });
  }

  land(session: string, at: number): void {
    this.append(session, { land: at });
  }

  acted(session: string, text: string, at: number): void {
    this.append(session, { acted: wordsHash(text), at });
  }

  remove(session: string): void {
    if (safeId(session)) rmSync(this.file(session), { force: true });
  }

  /** The spans the switch was on, oldest first; the last has no end while it is on. */
  periods(): SwitchPeriod[] {
    const out: SwitchPeriod[] = [];
    let text = "";
    try {
      text = readFileSync(join(this.dir, "switch.jsonl"), "utf8");
    } catch {
      return out;
    }
    for (const raw of text.split("\n")) {
      if (!raw) continue;
      try {
        const l = JSON.parse(raw);
        const last = out[out.length - 1];
        if (time(l?.on) && (!last || last.to !== null)) out.push({ from: l.on, to: null });
        else if (time(l?.off) && last && last.to === null) last.to = l.off;
      } catch { /* a torn line */ }
    }
    return out;
  }

  /** The switch's moves, kept: only messages sent while it was on are asked about or counted. */
  noteSwitch(on: boolean, now = Date.now()): void {
    const last = this.periods().at(-1);
    const isOn = !!last && last.to === null;
    if (on === isOn) return;
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(join(this.dir, "switch.jsonl"), `${JSON.stringify(on ? { on: now } : { off: now })}\n`);
  }
}

/** Read per call, as every state path is. A chat's own process reaches its server's folder. */
export const messageLabelStore = (): MessageLabelStore => new MessageLabelStore(join(chatStateRoot(), "message-labels"));

export const noteLabelSwitch = (on: boolean, now = Date.now()): void => messageLabelStore().noteSwitch(on, now);

const idOfPath = (path: string): string => basename(path, ".jsonl").split("_").pop() ?? "";

/** Waiting under a second isn't waiting: the entry's own time says the same. */
const PRESS_MATTERS_MS = 1000;

/** A message that waited in the queue entered the session: keep when it was pressed. Never in the send's way. */
export function recordPress(path: string, entryId: string, pressedAt: number, now = Date.now()): void {
  try {
    if (now - pressedAt < PRESS_MATTERS_MS || !readDecisionSettings().features.messageLabels) return;
    messageLabelStore().press(idOfPath(path), entryId, pressedAt);
  } catch (err) {
    console.error("[message-labels] could not keep a press time", err);
  }
}

/** A message no person sent entered the session. Its row reads as the user's, so this is what tells them apart after a reload. */
export function recordProgram(path: string, entryId: string): void {
  try {
    if (readDecisionSettings().features.messageLabels) messageLabelStore().program(idOfPath(path), entryId);
  } catch (err) {
    console.error("[message-labels] could not note a program's message", err);
  }
}

/** Land was pressed for a session's branch. A typed "land it" is a message and needs no record. */
export function recordLand(session: string, at: number): void {
  try {
    if (readDecisionSettings().features.messageLabels) messageLabelStore().land(session, at);
  } catch (err) {
    console.error("[message-labels] could not keep a Land press", err);
  }
}

/** A button is about to send these words to a session for the user (an offer's answer): that message is an action, and this its press. */
export function recordActed(path: string, text: string, at = Date.now()): void {
  try {
    if (readDecisionSettings().features.messageLabels) messageLabelStore().acted(idOfPath(path), text, at);
  } catch (err) {
    console.error("[message-labels] could not keep a button's press", err);
  }
}

/** A deleted session's labels go with it. Never in the way of the delete: the transcript is already gone. */
export function removeSessionLabels(session: string): void {
  try {
    messageLabelStore().remove(session);
  } catch (err) {
    console.error("[message-labels] could not remove a deleted session's labels", err);
  }
}
