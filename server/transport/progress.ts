// What the source keeps of the destination's progress (§app.transport/dialog): the destination's own steps, as it
// reports them on each poll, and the bytes it holds with when this device read them. The page draws the steps and the
// Sending bar from these (src/lib/transport-progress.ts); nothing here decides a step of the transport.
import type { StatusBody } from "./wire";
import { type Step, type TransportRecord, updateTransport } from "./store";

/** The steps only the destination marks: copied from its answer, never set here. */
export const THERE_STEPS: readonly Step[] = ["prepared", "pulled", "staged", "verified", "published", "opened"];

/** Readings of the bytes received kept for the speed: the newest few, each with when this device read it. */
export const SENT_SAMPLES = 8;

export interface SentSample {
  /** When this device read it (ms since the epoch). */
  at: number;
  /** Bytes the destination held then. */
  n: number;
}

/** The patch that brings `r` up to the destination's answer `s` at `now`: its steps as it says them now (one it no
    longer holds goes: a Retry that repacks starts it again), and a new reading of the bytes received while it sends.
    Null when nothing changed. Pure. */
export function therePatch(r: TransportRecord, s: StatusBody, now: number): Partial<TransportRecord> | null {
  const steps = { ...r.steps };
  let changed = false;
  for (const k of THERE_STEPS) {
    const v = typeof s.steps?.[k] === "string" ? s.steps[k] : undefined;
    if (steps[k] !== v) {
      changed = true;
      if (v === undefined) delete steps[k];
      else steps[k] = v;
    }
  }
  const ext = (r.ext ?? {}) as { sent?: SentSample[] };
  let sent: SentSample[] | undefined;
  if (typeof s.received === "number" && Number.isFinite(s.received) && s.received >= 0 && !s.steps?.pulled) {
    const was = Array.isArray(ext.sent) ? ext.sent : [];
    // A count lower than the last one is a pull started again: its readings start again too.
    const keep = was.length && s.received < was[was.length - 1]!.n ? [] : was;
    sent = [...keep, { at: now, n: s.received }].slice(-SENT_SAMPLES);
  }
  const received = typeof s.received === "number" && s.received !== r.received;
  if (!changed && !sent && !received) return null;
  return {
    ...(changed ? { steps } : {}),
    ...(received ? { received: s.received } : {}),
    ...(sent ? { ext: { sent } } : {}),
  };
}

/** Keep the destination's answer on the record; the record as it is now. */
export function mirrorThere(r: TransportRecord, s: StatusBody, now = Date.now()): TransportRecord {
  if (!therePatch(r, s, now)) return r;
  // Read again at the write: a Cancel or a step marked meanwhile stays as it is.
  return updateTransport(r.tid, (cur) => therePatch(cur, s, now) ?? {}) ?? r;
}
