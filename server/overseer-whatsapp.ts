import type { ToolSpec } from "../shared/harness";
import type { SenderStatus, SenderUnit } from "../shared/outreach";
import { attentionChanged } from "./attention-memo";
import { logAction } from "./overseer-store";
import { readOutreach } from "./outreach/settings";
import { defaultTarget, orgTarget, targetOf, type SenderTarget } from "./outreach/targets";
import { senderUnit, startable, startSenderUnit } from "./outreach/unit";
import { resetLocalClient, whatsapp } from "./outreach/whatsapp";

/**
 * `sova_whatsapp` (§app.outreach/overseer-sender), for both overseers: `status` reads a WhatsApp sender's state
 * afresh (any run), `start` is Settings' Start Sender and nothing more (§app.outreach/sender-controls): a sender of
 * this host that doesn't answer, whose systemd user unit is installed and inactive or failed, `systemctl --user
 * start` once, then its state read again. Never a restart, stop, reconnect, pause, link or pairing: re-linking is
 * the user's, in Settings → Outreach. The global Overseer names any sender (the default, an org's pick, an entry
 * id); a project overseer only its organization's sender, or this host's default for a standalone project.
 */

export const WA_ALREADY_RUNNING = "The sender is already running.";
export const waPeerRefusal = (host: string) => `That sender runs on ${host}: start it there.`;
export const WA_NO_UNIT = "Sova can't start this sender: it has no systemd user unit here.";
export const WA_OFF = "Outreach is off: there is no WhatsApp sender. The user sets one up in Settings → Outreach.";
export const WA_RELINK = "Settings → Outreach (Link a Phone)";
export const WA_UNPAIRED = "No device is linked to the sender yet: link a phone in Settings → Outreach on the sender's host.";

/** What the tool needs; the seams default to the real sender. */
export interface WhatsappToolDeps {
  /** "global": the main Overseer (any sender); "project": a project overseer (its org's sender only). */
  who: "global" | "project";
  /** A project overseer's organization (null: a standalone project). */
  orgOf?(): string | null;
  /** The global Overseer's `org` argument resolved to an org id (its refusal thrown otherwise). */
  resolveOrg?(ref: unknown): string;
  /** The run is the user's (global: a turn the user started; project: a run the operator started). */
  attended(): boolean;
  /** The refusal for an act outside such a run, as the overseer's other acts word it. */
  unattendedRefusal: string;
  overseerId(): string;
  /** The action log this overseer writes (a project overseer's activity); absent: the global Overseer's. */
  actionsFile?: () => string;
  refusal(message: string): Error;
  obj(properties: Record<string, unknown>, required?: string[]): any;
  str(description: string, extra?: Record<string, unknown>): unknown;
  status?(t: SenderTarget): Promise<SenderStatus>;
  unit?(socket: string, name?: string): Promise<SenderUnit | null>;
  start?(socket: string, name?: string): Promise<{ ok: true } | { ok: false; why: string }>;
}

class WaRefusal extends Error {}

/** An added number's name, for its unit (`sova-whatsapp@<name>.service`). */
const numberName = (t: SenderTarget) => ("number" in t.route ? t.route.number.id : undefined);

/** The sender's own sentence with no phone number (beyond 3 digits) and no path (under its home or anywhere). */
export function cleanWhy(why: string | undefined): string {
  if (!why) return "";
  return why
    .replace(/(^|[\s(:="'])(?:~|\/)[^\s"'`,;)]*/g, "$1[path]")
    .replace(/\+?\d[\d\s().-]{5,}\d/g, "[number]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

const time = (iso?: string) => (iso ? new Date(iso).toISOString().slice(11, 16) + " UTC" : "");

/** The state in words, and what can be done next (the user's step, or "start it"). Pure. */
export function senderText(t: SenderTarget, s: SenderStatus, unit: SenderUnit | null, hostPaused: boolean): string {
  const where = t.socket ? "this host" : `${t.label} (a peer)`;
  const local = !!t.socket;
  const stopped = local && s.state === "unreachable";
  const state = stopped ? "stopped: no process answers its socket" : s.state === "connecting" && s.retryAt ? `connecting (next try ${time(s.retryAt)})` : s.state === "down" && s.retryAt ? `down (next automatic try ${time(s.retryAt)})` : s.state;
  const why = s.state === "unpaired" ? WA_UNPAIRED : cleanWhy(s.why);
  const lines = [`WhatsApp sender ${t.label} (${t.id}), on ${where}: ${state}${s.me ? ` · linked number ${s.me}` : ""}.`];
  if (why) lines.push(`The sender says: ${why}`);
  const paused = [...(s.paused ? ["paused on its host"] : []), ...(hostPaused ? ["all sending from this host is paused (Settings → Outreach)"] : [])];
  if (paused.length) lines.push(`Paused: ${paused.join("; ")}.`);
  lines.push(`What can be done: ${nextStep(t, s, unit)}`);
  return lines.join("\n");
}

function nextStep(t: SenderTarget, s: SenderStatus, unit: SenderUnit | null): string {
  switch (s.state) {
    case "open":
      return "nothing: it is connected.";
    case "linking":
      return "the user is linking a phone in Settings → Outreach; wait for it.";
    case "connecting":
      return "nothing: it reconnects on its own.";
    case "down":
      return "it retries on its own; the user can press Reconnect Now in Settings → Outreach.";
    case "logged-out":
    case "replaced":
    case "unpaired":
      return `a phone needs linking again: tell the user to re-link it in ${WA_RELINK} on ${t.socket ? "this host" : t.label}. You never link, pair or ask for a code.`;
    case "blocked":
      return "WhatsApp blocked this account: only the user reconnects it, in Settings → Outreach on its host (waiting a day or more is safer).";
    case "off":
      return "nothing here: outreach is off.";
    case "unreachable":
      if (!t.socket) return `it runs on ${t.label}: the user checks it there.`;
      if (startable(unit)) return `start it (sova_whatsapp start runs systemctl --user start ${unit!.name} once).`;
      if (unit) return `its unit ${unit.name} is ${unit.active}; wait and read the status again.`;
      return `${WA_NO_UNIT} The user starts it on this host.`;
  }
}

export function whatsappTool(d: WhatsappToolDeps): ToolSpec {
  const status = d.status ?? ((t: SenderTarget) => whatsapp.status(t));
  const unitOf = d.unit ?? ((socket: string, name?: string) => senderUnit(socket, name).catch(() => null));
  const start = d.start ?? startSenderUnit;

  /** The sender the call names: a project overseer's org's (or the default); the global Overseer's pick. */
  function targetFor(p: any): SenderTarget {
    const file = readOutreach();
    if (d.who === "project") {
      if (p.sender !== undefined || p.org !== undefined) throw new WaRefusal("You reach only the sender your project sends through: leave out sender and org.");
      const org = d.orgOf?.() ?? null;
      const t = org ? orgTarget(org, file).target : defaultTarget(file);
      if (!t) throw new WaRefusal(WA_OFF);
      return t;
    }
    if (p.sender !== undefined && p.org !== undefined) throw new WaRefusal("Name the sender (an entry id) or the org, not both.");
    if (typeof p.sender === "string" && p.sender.trim()) {
      const t = targetOf(p.sender.trim(), file, undefined, true);
      if (!t) throw new WaRefusal(`No sender this host can use has the id ${p.sender.trim()} (local, local:<name> or peer:<id>).`);
      return t;
    }
    if (p.org !== undefined && p.org !== null && p.org !== "") {
      let orgId: string;
      try {
        orgId = d.resolveOrg ? d.resolveOrg(p.org) : String(p.org);
      } catch (err) {
        throw new WaRefusal(err instanceof Error ? err.message : String(err));
      }
      const t = orgTarget(orgId, file).target;
      if (!t) throw new WaRefusal(WA_OFF);
      return t;
    }
    const t = defaultTarget(file);
    if (!t) throw new WaRefusal(WA_OFF);
    return t;
  }

  async function read(t: SenderTarget): Promise<string> {
    const s = await status(t);
    const unit = t.socket && s.state === "unreachable" ? await unitOf(t.socket, numberName(t)) : null;
    return senderText(t, s, unit, readOutreach().paused === true);
  }

  async function startOp(t: SenderTarget): Promise<string> {
    if (!t.socket) throw new WaRefusal(waPeerRefusal(t.label));
    if ((await status(t)).state !== "unreachable") throw new WaRefusal(WA_ALREADY_RUNNING);
    const unit = await unitOf(t.socket, numberName(t));
    if (!unit) throw new WaRefusal(WA_NO_UNIT);
    if (!startable(unit)) throw new WaRefusal(`${unit.name} is ${unit.active}: Sova starts it only while it is stopped.`);
    const r = await start(t.socket, numberName(t));
    // A fresh connection: the next read finds the sender as soon as it listens.
    resetLocalClient();
    if (!r.ok) throw new WaRefusal(r.why);
    attentionChanged();
    return `Ran systemctl --user start ${unit.name} once. Read afresh (it may take a few seconds to answer):\n${await read(t)}`;
  }

  return {
    name: "sova_whatsapp",
    label: "WhatsApp sender",
    description:
      (d.who === "global"
        ? "This host's WhatsApp senders: the default, an organization's pick (org) or an added number (sender: its entry id, local:<name>). "
        : "Your project's WhatsApp sender (the one its organization sends through, or this host's default for a standalone project). ") +
      "status (any run): its state read afresh (open, connecting, down, logged-out, replaced, blocked, unpaired, unreachable, or stopped: no process answers its socket), the sender's own sentence, whether it is paused, and what can be done. " +
      `start (only in a run ${d.who === "global" ? "the user" : "the operator"} started): Settings' Start Sender, once: only for a sender on this host that doesn't answer and whose systemd user unit is installed and stopped or failed; never a restart, stop, reconnect or loop. ` +
      "A sender that is logged out, replaced or unpaired needs a phone linked again: tell the user to re-link it in Settings → Outreach (Link a Phone) on the sender's host; you never link, pair or ask for a code.",
    promptSnippet: "the WhatsApp sender's state; start a stopped one (Start Sender)",
    parameters: d.obj(
      {
        op: d.str("status | start", { enum: ["status", "start"] }),
        ...(d.who === "global"
          ? { org: d.str("Optional: the organization whose sender (its pick, else the default); id or exact name."), sender: d.str("Optional: a sender's entry id (local, local:<name>, peer:<id>).") }
          : {}),
      },
      ["op"],
    ),
    execute: async (toolCallId: string, params: any) => {
      const p = params ?? {};
      let label: string | undefined;
      // The sender by its label, never a number (§app.outreach/overseer-sender).
      const log = (outcome: "ok" | "refused" | "error", error?: string) => {
        const entry = { at: new Date().toISOString(), overseerId: d.overseerId(), toolCallId, tool: "sova_whatsapp", args: { op: p.op, ...(label ? { sender: label } : {}) }, outcome, ...(error ? { error } : {}) };
        if (d.actionsFile) logAction(entry, d.actionsFile());
        else logAction(entry);
      };
      try {
        if (p.op !== "status" && p.op !== "start") throw new WaRefusal("op must be status or start.");
        if (p.op === "start" && !d.attended()) throw new WaRefusal(d.unattendedRefusal);
        const t = targetFor(p);
        label = t.label;
        const out = p.op === "start" ? await startOp(t) : await read(t);
        log("ok");
        return { content: [{ type: "text" as const, text: out }], details: { sender: t.id } };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const refused = err instanceof WaRefusal || (err as { status?: unknown })?.status !== undefined;
        log(refused ? "refused" : "error", message);
        throw refused ? d.refusal(message) : err;
      }
    },
  } as ToolSpec;
}
