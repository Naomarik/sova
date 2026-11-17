/**
 * A playbook's flow as a diagram for its card: a `vis flow` (or, for a playbook that declares a
 * machine, a `vis state`) source drawn by Sova's own vis renderer. Derived from the parsed
 * playbook.json alone, so the picture can't drift from what runs: the steps in order with the teams
 * that work in each, the repeating group as a loop labelled with its cap and how often it asks you,
 * and every stop point (always, or optional and whether it is on); or the machine's states and the
 * named moves between them.
 *
 * Optional run progress colours what is known: steps already taken (ok), the current one (accent).
 * A run that knows only that it started or stopped says so in the caption and colours nothing.
 *
 * Pure and DOM-free: the server or the page calls it; the page draws the result as a fence body.
 */
import { cycleOf, type CycleSettings, type PlaybookSpec, type PlaybookStep } from "./playbook-format";

/** What a run knows of where it is. Every part is optional: phase 1 may know only started or stopped. */
export interface FlowProgress {
  /** The step (or machine state) being worked on now. */
  current?: string;
  /** Steps (or states) already taken, in any order. */
  done?: readonly string[];
  /** The run as a whole. */
  state?: "draft" | "running" | "waiting" | "stopped" | "finished";
  /** The cycle the run is in, from 1. */
  cycle?: number;
}

export interface FlowOptions {
  /** A title over the drawing (the playbook's name). */
  title?: string;
  /** The card's cycle settings, when you changed them; default: the playbook's. */
  cycle?: CycleSettings;
  /** Each optional stop on (true) or off, by step id, as the card has it; default: the playbook's. */
  stops?: Readonly<Record<string, boolean>>;
  progress?: FlowProgress;
}

/** A fence's kind word and body: draw it as ```vis <kind>\n<body>\n```. */
export interface FlowSource {
  kind: "flow" | "state";
  body: string;
}

const RUN_STATE: Record<NonNullable<FlowProgress["state"]>, string> = {
  draft: "Not started",
  running: "Running",
  waiting: "Waiting for you",
  stopped: "Stopped",
  finished: "Finished",
};

/** A quoted vis string: backslashes and quotes escaped, one line. */
const q = (s: string) => `"${s.replace(/\s+/g, " ").trim().replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
/** Ids carry a prefix, so no step id can read as a vis keyword (`node`, `group`, `mark`, `title:`). */
const sid = (id: string) => `s_${id}`;
const tid = (id: string) => `st_${id}`;

/** The second line of a step's box: who works in it, and whether the run stops there for you. */
function stepNote(step: Pick<PlaybookStep, "id" | "teams" | "stop" | "startsOff">, teamLabel: (id: string) => string, stops: FlowOptions["stops"]): string {
  const who = step.teams.length ? step.teams.map(teamLabel).join(" + ") : "Main chat";
  if (step.stop === "always") return `${who} · stops for you`;
  if (step.stop === "optional") return `${who} · ${(stops?.[step.id] ?? !step.startsOff) ? "optional stop: on" : "optional stop: off"}`;
  return who;
}

function tone(id: string, p: FlowProgress | undefined): string {
  if (p?.current === id) return " accent";
  if (p?.done?.includes(id)) return " ok";
  return "";
}

function header(o: FlowOptions): string[] {
  const out: string[] = [];
  if (o.title) out.push(`title: ${o.title.replace(/\s+/g, " ").trim()}`);
  const p = o.progress;
  if (p?.state) out.push(`caption: ${RUN_STATE[p.state]}${p.cycle ? ` · cycle ${p.cycle}` : ""}`);
  else if (p?.cycle) out.push(`caption: Cycle ${p.cycle}`);
  return out;
}

/** "at most 5 · asks you every 2" (every cycle: "asks you after each"). */
export function cycleWords(s: CycleSettings): string {
  const ask = s.askEvery >= s.max ? "asks you at the end" : s.askEvery === 1 ? "asks you after each" : `asks you every ${s.askEvery}`;
  return `at most ${s.max} · ${ask}${s.until === "rule" ? " · or until its stop rule" : ""}`;
}

/** The playbook's flow as a vis source (see the file's comment). */
export function playbookFlowSource(spec: PlaybookSpec, o: FlowOptions = {}): FlowSource {
  const teamLabel = (id: string) => spec.teams.find((t) => t.id === id)?.label ?? id;
  return spec.machine ? machineSource(spec, teamLabel, o) : stepsSource(spec, teamLabel, o);
}

function stepsSource(spec: PlaybookSpec, teamLabel: (id: string) => string, o: FlowOptions): FlowSource {
  const lines = header(o);
  const p = o.progress;
  if (!spec.steps.length) {
    lines.push(`node ${sid("main")} ${q("The main chat runs it")} round`);
    return { kind: "flow", body: lines.join("\n") };
  }
  const edges: string[] = [];
  let prev: string | null = null;
  for (const item of spec.steps) {
    if (item.kind === "step") {
      lines.push(`node ${sid(item.id)} ${q(item.label)} ${q(stepNote(item, teamLabel, o.stops))}${tone(item.id, p)}`);
      if (prev) edges.push(`${prev} -> ${sid(item.id)}`);
      prev = sid(item.id);
      continue;
    }
    const settings = o.cycle ?? item.settings;
    const ids = item.steps.map((s) => sid(s.id));
    for (const s of item.steps) lines.push(`node ${sid(s.id)} ${q(s.label)} ${q(stepNote(s, teamLabel, o.stops))}${tone(s.id, p)}`);
    if (prev) edges.push(`${prev} -> ${ids[0]}`);
    for (let i = 1; i < ids.length; i++) edges.push(`${ids[i - 1]} -> ${ids[i]}`);
    edges.push(`${ids.at(-1)} --> ${ids[0]} ${q(`again: ${cycleWords(settings)}`)}`);
    lines.push(`group ${q(`${item.label} (repeats)`)} ${ids.join(" ")}`);
    prev = ids.at(-1)!;
  }
  return { kind: "flow", body: [...lines, ...edges].join("\n") };
}

function machineSource(spec: PlaybookSpec, teamLabel: (id: string) => string, o: FlowOptions): FlowSource {
  const m = spec.machine!;
  const p = o.progress;
  const lines = header(o);
  lines.push("node start start");
  const finals = m.states.filter((s) => !Object.keys(s.on).length);
  if (finals.length) lines.push("node end end");
  for (const s of m.states) {
    const note = s.quiet ? "ends quietly" : stepNote(s, teamLabel, o.stops);
    lines.push(`node ${tid(s.id)} ${q(s.label)} ${q(note)}${tone(s.id, p)}`);
  }
  lines.push(`start -> ${tid(m.initial)}`);
  for (const s of m.states) {
    for (const [ev, t] of Object.entries(s.on)) lines.push(`${tid(s.id)} -> ${tid(t.to)} ${q(t.limit ? `${ev} (at most ${t.limit}×)` : ev)}`);
  }
  for (const s of finals) lines.push(`${tid(s.id)} -> end`);
  return { kind: "state", body: lines.join("\n") };
}

/** The cycle settings the drawing shows: the card's, else the playbook's (undefined: no repeating group). */
export const shownCycle = (spec: PlaybookSpec, o: FlowOptions = {}): CycleSettings | undefined => o.cycle ?? cycleOf(spec)?.settings;
