// Pure parser for wake-nudge messages (pi-config/extensions/wake-nudge.ts): at fire time the
// extension sends a real `role:"user"` message whose first line tags it. Shared between the
// server (classifying transcript rows) and the client (the live/streamed path), so both agree on
// what counts as a nudge from the tag alone — pi's `sendUserMessage` carries no other signal.
//
// The four lines the extension writes, verbatim (server/transcript.ts keeps `text` exactly this):
//   [wake_nudge n1] Scheduled wakeup fired (set 4m17s ago).
//   Overdue by 3m17s (pi was not running).            <- only when late
//   Reason: <reason, or "(none)">
//   <standing instruction>
//
// A playbook schedule's fire (§chat.schedules/fire, server/schedules.ts) is a wake too, tagged
// `[schedule s1]`, with an optional "Late by … (Sova was not running)." line and its reason; what
// follows is its instruction and the playbook block (§chat.schedules/delivery), so only the two lines
// after the tag are read, and the block's opening tag for its load.
import { parseBlockTags, type Load } from "./playbook-delivery";

const TAG_RE = /^\[wake_nudge (n\d+)\]/;
/** A tour recording waiting for a sign-in tells its chat (§app.tours/sites, server/tours/sign-in-notice.ts):
    `[tour_sign_in t1] A tour recording is waiting for a sign-in.`, then `Reason: …` and an instruction. */
export const TOUR_SIGN_IN_TAG = "[tour_sign_in";
const TOUR_TAG_RE = /^\[tour_sign_in (t\d+)\] /;
const SCHEDULE_TAG_RE = /^\[schedule (s\d+)\] Scheduled run fired /;
const LATE_RE = /^Late by (.+?) \(Sova was not running\)\.$/;
const OVERDUE_RE = /^Overdue by (.+?) \(pi was not running\)\.$/;
const REASON_RE = /^Reason: (.*)$/;

export interface WakeInfo {
  id: string; // "n1"
  late?: string; // "Overdue by …" duration, only when the nudge fired late
  reason?: string; // absent when the extension wrote "Reason: (none)"
  /** A playbook schedule's fire (`[schedule sN]`), not a wake_nudge. */
  schedule?: true;
  /** A tour recording's sign-in notice (`[tour_sign_in tN]`), not a wake_nudge. */
  tour?: true;
  /** The playbook its block carried, and how (§chat.schedules/delivery). */
  playbook?: { id: string; load: Load };
}

/** Parses a wake-nudge message by its tag alone. The tag must open the first line; a later line
    with the same shape does not count (that would be a message merely quoting one). */
export function parseWakeNudge(text: string | null | undefined): WakeInfo | null {
  if (!text) return null;
  const lines = text.split(/\r\n|\r|\n/);
  const first = lines[0] ?? "";
  const s = SCHEDULE_TAG_RE.exec(first);
  if (s) {
    const info: WakeInfo = { id: s[1]!, schedule: true };
    for (const line of lines.slice(1, 3)) {
      const late = LATE_RE.exec(line.trim());
      if (late) info.late = late[1];
      const reason = REASON_RE.exec(line.trim());
      if (reason) info.reason = reason[1];
    }
    const tag = parseBlockTags(text)[0];
    if (tag) info.playbook = { id: tag.id, load: tag.load };
    return info;
  }
  const t = TOUR_TAG_RE.exec(first);
  if (t) {
    const info: WakeInfo = { id: t[1]!, tour: true };
    const reason = REASON_RE.exec((lines[1] ?? "").trim());
    if (reason) info.reason = reason[1];
    return info;
  }
  const m = TAG_RE.exec(first);
  if (!m) return null;
  const info: WakeInfo = { id: m[1]! };
  for (const line of lines.slice(1)) {
    const overdue = OVERDUE_RE.exec(line.trim());
    if (overdue) info.late = overdue[1];
    const reason = REASON_RE.exec(line.trim());
    if (reason && reason[1] !== "(none)") info.reason = reason[1];
  }
  return info;
}

/** "Wake nudge n1" / "Scheduled run s1": the card's name and the Timeline's fallback label when there's no reason. */
export const wakeTitle = (nudge: WakeInfo): string => (nudge.tour ? "Tour sign-in" : nudge.schedule ? `Scheduled run ${nudge.id}` : `Wake nudge ${nudge.id}`);
