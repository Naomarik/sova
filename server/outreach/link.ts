import type { SenderLinkView } from "../../shared/outreach";
import type { Frame, SenderClient, SenderEvent } from "./ipc-client";

/**
 * A link Sova started on its own host's sender (§app.outreach/sender-link), for the operator's page to
 * poll. Only the link the operator's Link a Phone started is followed: a `qr` event while none runs
 * here (a terminal's `sova-whatsapp pair`) is dropped. The QR and the pairing code are as good as the
 * number's credentials, so this module keeps only the newest, in memory, and drops it when the link
 * ends; nothing here logs, writes or relays them.
 */

/** The phone number a pairing code is for: E.164 digits, country code first, no +. */
export const PHONE_DIGITS = /^\d{7,15}$/;

interface Run {
  mode: "qr" | "code";
  phase: "starting" | "waiting" | "linked" | "ended";
  qr?: string;
  qrCount: number;
  code?: string;
  phoneTail?: string;
  me?: string;
  why?: string;
}

let run: Run | null = null;

const live = (r: Run | null): r is Run => !!r && (r.phase === "starting" || r.phase === "waiting");

function end(r: Run, phase: "linked" | "ended", fields: { me?: string; why?: string }): void {
  r.phase = phase;
  delete r.qr;
  delete r.code;
  if (fields.me) r.me = fields.me;
  if (fields.why) r.why = fields.why;
}

/** What the page sees now. */
export function linkView(): SenderLinkView {
  if (!run) return { phase: "idle" };
  const r = run;
  return {
    phase: r.phase,
    mode: r.mode,
    ...(r.qr ? { qr: r.qr, qrCount: r.qrCount } : {}),
    ...(r.code ? { code: r.code } : {}),
    ...(r.phoneTail ? { phoneTail: r.phoneTail } : {}),
    ...(r.me ? { me: r.me } : {}),
    ...(r.why ? { why: r.why } : {}),
  };
}

/** The local sender's events (./whatsapp.ts hands each one here): a new QR, the phone linked, or the link ended. */
export function noteLinkEvent(e: SenderEvent): void {
  const r = run;
  if (!live(r)) return;
  if (e.ev === "qr") {
    if (r.mode !== "qr" || typeof e.qr !== "string") return;
    r.qr = e.qr;
    r.qrCount++;
    r.phase = "waiting";
    return;
  }
  if (e.ev === "paired") return end(r, "linked", { me: typeof e.me === "string" ? e.me : undefined });
  if (e.ev !== "state") return;
  if (e.state === "linking") r.phase = "waiting";
  else if (e.state === "open") end(r, "linked", {});
  // Before `linking` the sender may still say unpaired from before this link: only an unpaired after it ends it.
  else if (e.state === "unpaired" && r.phase === "waiting") end(r, "ended", { why: typeof e.why === "string" ? e.why : "Linking stopped." });
}

const whyOf = (f: Frame, fallback: string) => (typeof f.why === "string" ? f.why : fallback);

/** Start a link: a QR, or with `phone` a pairing code. Refusals keep any link already running as it is. */
export async function startLink(client: SenderClient, phone?: string): Promise<{ ok: true; view: SenderLinkView } | { ok: false; why: string; code?: string }> {
  if (phone !== undefined && !PHONE_DIGITS.test(phone)) return { ok: false, code: "invalid", why: "The phone number must be 7 to 15 digits, country code first, no +." };
  if (live(run)) return { ok: false, code: "busy", why: "A link is already in progress." };
  const r: Run = { mode: phone ? "code" : "qr", phase: "starting", qrCount: 0, ...(phone ? { phoneTail: `…${phone.slice(-3)}` } : {}) };
  run = r;
  let f: Frame;
  try {
    // A pairing code waits for WhatsApp to answer, so this may take a while.
    f = await client.request("link", phone ? { phone } : {}, 45_000);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    if (run === r) end(r, "ended", { why });
    return { ok: false, code: "unreachable", why };
  }
  if (f.ok === false) {
    const why = whyOf(f, "The sender refused to link.");
    // The sender's own refusals (linked, busy) leave nothing of ours running.
    if (run === r) run = null;
    return { ok: false, why, ...(typeof f.code === "string" ? { code: f.code } : {}) };
  }
  if (run === r && live(r)) {
    if (typeof f.pairingCode === "string") r.code = f.pairingCode;
    r.phase = "waiting";
  }
  return { ok: true, view: linkView() };
}

/** End the link in progress (the sender's `link {cancel: true}`). */
export async function cancelLink(client: SenderClient): Promise<{ ok: true; view: SenderLinkView } | { ok: false; why: string; code?: string }> {
  let f: Frame;
  try {
    f = await client.request("link", { cancel: true }, 10_000);
  } catch (err) {
    return { ok: false, code: "unreachable", why: err instanceof Error ? err.message : String(err) };
  }
  if (f.ok === false) {
    // Nothing runs on the sender: whatever this module still followed is over too.
    if (f.code === "not-linking" && live(run)) end(run, "ended", { why: "Linking was cancelled." });
    else return { ok: false, why: whyOf(f, "The sender refused."), ...(typeof f.code === "string" ? { code: f.code } : {}) };
  }
  if (live(run)) end(run, "ended", { why: "Linking was cancelled." });
  return { ok: true, view: linkView() };
}

/** Forget the link (an unlink, a change of the setting): the page shows none. */
export function dropLink(): void {
  run = null;
}
