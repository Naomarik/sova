// A transport's progress as the dialog and the chat's head draw it (§app.transport/dialog, words in
// §design.copy-deck/transport): its steps in order with the current one, and while it sends, how much of the
// package arrived, how fast and how long is left. Read from the record's finished steps, never its state alone:
// the source says "switching" both while a Move stops what runs and after the switch is decided.
import type { TransportView } from "./transport-api";

export type ProgressStepId = "prepare" | "helpers" | "stop" | "pack" | "send" | "check" | "open";
export interface ProgressStep {
  id: ProgressStepId;
  label: string;
  state: "done" | "current" | "failed" | "todo";
}

type View = Pick<TransportView, "mode" | "state" | "steps" | "peerLabel" | "ext">;

/** The steps of transport `t`, in order: each done, the current one (failed when it needs you), the rest to do. */
export function transportSteps(t: View): ProgressStep[] {
  const s = t.steps ?? {};
  const device = t.peerLabel;
  const move = t.mode === "move";
  // Each step with what says it is over; one over means every step before it is too.
  const all: { id: ProgressStepId; label: string; over: boolean; shown: boolean }[] = [
    { id: "prepare", label: `Preparing ${device}`, over: !!s.prepared, shown: true },
    // Only a Move whose helpers were busy waits for them.
    { id: "helpers", label: "Waiting for helpers", over: !!s.stopped || t.state === "switching", shown: move && (t.ext?.waitedHelpers === true || (t.state === "waiting-helpers" && (t.ext?.waiting ?? 0) > 0)) },
    { id: "stop", label: "Stopping jobs and running copies", over: !!s.stopped, shown: move },
    { id: "pack", label: "Packing", over: !!s.packed, shown: true },
    { id: "send", label: "Sending", over: !!s.pulled, shown: true },
    { id: "check", label: `Checking on ${device}`, over: !!s.verified, shown: true },
    { id: "open", label: `Opening on ${device}`, over: !!s.opened, shown: true },
  ];
  const steps = all.filter((x) => x.shown);
  let reached = -1;
  steps.forEach((x, i) => x.over && (reached = i));
  if (t.state === "done") reached = steps.length - 1;
  return steps.map((x, i) => ({
    id: x.id,
    label: x.label,
    state: i <= reached ? "done" : i === reached + 1 ? (t.state === "needs-you" ? "failed" : "current") : "todo",
  }));
}

/** The step under way (or the one it stopped at), null once done. */
export const currentStep = (t: View): ProgressStep | null => transportSteps(t).find((x) => x.state === "current" || x.state === "failed") ?? null;

export interface SentSample {
  at: number;
  n: number;
}

/** Readings spanning less than this give no speed yet. */
const MIN_SPAN_MS = 2_500;
/** Readings older than this, before the newest, are left out of the speed. */
const WINDOW_MS = 12_000;

/** Bytes a second over the newest readings, or null while there are too few or nothing moved across them (a speed
    is never shown as zero, and never from one reading: one burst would make it jump). */
export function sendRate(samples: readonly SentSample[] | undefined): number | null {
  if (!samples?.length) return null;
  const last = samples[samples.length - 1]!;
  const win = samples.filter((x) => last.at - x.at <= WINDOW_MS && x.at <= last.at);
  const first = win[0]!;
  const span = last.at - first.at;
  if (win.length < 3 || span < MIN_SPAN_MS) return null;
  const rate = ((last.n - first.n) / span) * 1000;
  return rate > 0 && Number.isFinite(rate) ? rate : null;
}

const UNITS: readonly [number, string][] = [
  [1024 * 1024 * 1024, "GB"],
  [1024 * 1024, "MB"],
  [1024, "KB"],
];
const unitOf = (n: number): [number, string] => UNITS.find(([d]) => n >= d) ?? [1, "bytes"];
const num = (n: number): string => (n >= 0.05 && n < 10 && !Number.isInteger(n) ? n.toFixed(1).replace(/\.0$/, "") : String(Math.round(n)));

/** "12 of 34 MB": both in the whole's unit. */
export function ofSize(received: number, total: number): string {
  const [d, u] = unitOf(total);
  const r = Math.min(received, total) / d;
  return `${num(r)} of ${num(total / d)} ${u}`;
}

/** "4.1 MB/s". */
export function speedText(bps: number): string {
  const [d, u] = unitOf(bps);
  return `${num(bps / d)} ${u}/s`;
}

/** "a few seconds left", "35 s left", "4 min left", "1 h 5 min left". Never zero, never endless. */
export function timeLeftText(remaining: number, bps: number): string | null {
  if (!(bps > 0) || !Number.isFinite(remaining) || remaining <= 0) return null;
  const secs = Math.ceil(remaining / bps);
  if (!Number.isFinite(secs)) return null;
  if (secs < 10) return "a few seconds left";
  if (secs < 60) return `${Math.ceil(secs / 5) * 5} s left`;
  const mins = Math.ceil(secs / 60);
  if (mins < 60) return `${mins} min left`;
  return `${Math.floor(mins / 60)} h ${mins % 60} min left`;
}

export interface SendingView {
  received: number;
  total: number;
  /** 0–100, for the bar. */
  percent: number;
  /** "12 of 34 MB". */
  amount: string;
  speed: string | null;
  left: string | null;
}

/** While it sends: the bar's figures; null at any other step. */
export function sendingOf(t: View & Pick<TransportView, "pkg" | "received">): SendingView | null {
  if (currentStep(t)?.id !== "send" || !t.pkg?.size) return null;
  const total = t.pkg.size;
  const received = Math.max(0, Math.min(t.received ?? 0, total));
  const bps = sendRate(t.ext?.sent);
  return {
    received,
    total,
    percent: Math.round((received / total) * 100),
    amount: ofSize(received, total),
    speed: bps ? speedText(bps) : null,
    left: bps ? timeLeftText(total - received, bps) : null,
  };
}

/** The chat head's line while a transport runs, in its two parts: where it goes ("Moving to Laptop") and the step
    ("Sending 12 of 34 MB", "Needs you"); null once it ended. */
export function headParts(t: View & Pick<TransportView, "pkg" | "received">): { lead: string; step: string | null } | null {
  if (t.state === "done" || t.state === "cancelled") return null;
  const lead = `${t.mode === "move" ? "Moving" : "Copying"} to ${t.peerLabel}`;
  if (t.state === "needs-you") return { lead, step: "Needs you" };
  const cur = currentStep(t);
  if (!cur) return { lead, step: null };
  const sending = cur.id === "send" ? sendingOf(t) : null;
  return { lead, step: sending ? `Sending ${sending.amount}` : cur.label };
}

/** The chat head's line as one ("Moving to Laptop · Sending 12 of 34 MB"); null once it ended. */
export function headLine(t: View & Pick<TransportView, "pkg" | "received">): string | null {
  const p = headParts(t);
  return p ? (p.step ? `${p.lead} · ${p.step}` : p.lead) : null;
}
