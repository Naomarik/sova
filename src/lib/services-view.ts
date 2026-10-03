// The Services tab and Running copies (§app.project-services/services-ui) as words. Pure: no Solid, no DOM.

import type { InstanceState, LinkView, ServiceState, VerbResult } from "../../shared/project-contract";
import type { CopyView, ServiceRowView } from "../../shared/services-view";
import { bytesWord, type ChipTone } from "./project-software";
import { expiresWord } from "./session-shares";

/** A copy's name: `main` for the main checkout's (slot 0), else its branch, else its folder. */
export function copyName(c: Pick<CopyView, "slot" | "branch" | "checkout">): string {
  if (c.slot === 0) return "main";
  return c.branch ?? c.checkout.split("/").filter(Boolean).pop() ?? c.checkout;
}

export const COPY_CHIP: Record<InstanceState, { word: string; tone?: ChipTone }> = {
  running: { word: "Running", tone: "success" },
  degraded: { word: "Degraded", tone: "warn" },
  stopped: { word: "Stopped" },
  absent: { word: "Absent" },
};

export const SERVICE_WORD: Record<ServiceState, string> = {
  stopped: "stopped",
  starting: "starting",
  ready: "ready",
  degraded: "degraded",
  failed: "failed",
  external: "port held by something else",
};

export const SERVICE_CHIP: Record<ServiceState, { word: string; tone?: ChipTone }> = {
  stopped: { word: "Stopped" },
  starting: { word: "Starting", tone: "info" },
  ready: { word: "Ready", tone: "success" },
  degraded: { word: "Degraded", tone: "warn" },
  failed: { word: "Failed", tone: "error" },
  external: { word: "External", tone: "warn" },
};

/** The sum of the services' resident memory, or "—" when none reports one. */
export function copyMemory(services: readonly Pick<ServiceRowView, "rssBytes">[]): string {
  const r = services.filter((s) => typeof s.rssBytes === "number");
  return r.length ? bytesWord(r.reduce((n, s) => n + s.rssBytes!, 0)) : "—";
}
export const memoryOf = (bytes: number | null): string => (bytes === null ? "—" : bytesWord(bytes));

/** Who made the copy, in the page's words; the tag itself is the title. */
export function createdByWord(tag: string): string {
  const kind = tag.split(":")[0];
  if (kind === "operator") return "you";
  if (kind === "overseer") return "the Overseer";
  if (kind === "project-overseer") return "its overseer";
  if (kind === "session") return "a coding session";
  if (kind === "conform") return "conformance";
  return tag;
}

/** The services of a copy that are not ready, as "web stopped · api failed"; null when all are. */
export function notReadyLine(services: readonly ServiceRowView[]): string | null {
  const off = services.filter((s) => s.state !== "ready");
  return off.length ? off.map((s) => `${s.name} ${SERVICE_WORD[s.state]}`).join(" · ") : null;
}

/** A port with HTTP readiness, on the host this page was opened from. */
export const httpHref = (host: string, http: { port: number; path: string }): string => `http://${host.includes(":") ? `[${host}]` : host}:${http.port}${http.path.startsWith("/") ? http.path : `/${http.path}`}`;

/** The verbs a copy's row offers, in order. */
export type RowVerb = "up" | "down" | "apply" | "reset" | "teardown";
export const VERB_LABEL: Record<RowVerb, string> = { up: "Start", down: "Stop", apply: "Apply", reset: "Reset", teardown: "Teardown" };
export const VERB_RUNNING: Record<RowVerb, string> = { up: "Starting…", down: "Stopping…", apply: "Applying…", reset: "Resetting…", teardown: "Tearing down…" };
/** Asked first: the first click arms the button, the second runs it confirmed. */
export const ASKS_FIRST: ReadonlySet<RowVerb> = new Set(["reset", "teardown"]);
export const confirmLabel = (v: RowVerb): string => `Confirm ${VERB_LABEL[v]}`;

/** The toast after a verb that did what it was asked. */
export function doneLine(verb: RowVerb, name: string): string {
  switch (verb) {
    case "up":
      return `Started ${name}.`;
    case "down":
      return `Stopped ${name}.`;
    case "apply":
      return `Applied ${name}.`;
    case "reset":
      return `Reset ${name}.`;
    case "teardown":
      return `Tore down ${name}. Its slot is free.`;
  }
}

/** The engine's message as a sentence, without the CLI's own "(sova-project … --confirm)" hint. */
export function sentence(message: string): string {
  const t = message.replace(/\s*\(sova-project[^)]*\)/g, "").trim();
  if (!t) return "";
  const s = t[0]!.toUpperCase() + t.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

/**
 * A refused or failed result, as the sentence under its row, or null when it did what it was asked.
 * `needs-confirm` and `busy` say what to do next; the button arms itself on `needs-confirm`.
 */
export function refusalLine(r: Pick<VerbResult, "ok" | "error">): string | null {
  if (!r.error) return r.ok ? null : "It didn't finish. Read its logs.";
  const said = sentence(r.error.message);
  if (r.error.code === "needs-confirm") return `${said} Press it again to confirm.`;
  if (r.error.code === "busy") return /try again/i.test(said) ? said : `${said} Try again once they are idle.`;
  return said;
}

// ---- Share (§app.project-services/share) -----------------------------------------------------------

/** The Share form's expiry choices, in days (the engine caps a definition's lower `share.maxDays`). */
export const SHARE_DAY_CHOICES = [1, 2, 3, 4, 5, 6, 7] as const;
export const SHARE_SENSITIVE = "Derived from production: copies are never shared.";

/** The port an endpoint (`<service>.<port>`) names in this copy, or null. */
export function endpointPort(c: Pick<CopyView, "services">, endpoint: string): number | null {
  const dot = endpoint.indexOf(".");
  const s = c.services.find((x) => x.name === endpoint.slice(0, dot));
  return s?.ports[endpoint.slice(dot + 1)] ?? null;
}

/** Why Share is unavailable on this copy, or null: sensitive data first, then the engine's own reason. */
export function shareBlocked(c: Pick<CopyView, "share">, sensitive: boolean): string | null {
  if (sensitive) return SHARE_SENSITIVE;
  return c.share?.refused ?? null;
}

/** A link's chip: its endpoint, then when it ends. */
export const linkLine = (l: Pick<LinkView, "endpoint" | "expiresAt">, now: number): string => `${l.endpoint} · ${expiresWord(l.expiresAt, now).replace(/^E/, "e")}`;

/** Why the chosen endpoint can't be shared now (its service isn't ready), or null. Sharing never starts anything. */
export function endpointNotRunning(c: Pick<CopyView, "services">, endpoint: string): string | null {
  const name = endpoint.slice(0, endpoint.indexOf("."));
  const s = c.services.find((x) => x.name === name);
  return s && s.state === "ready" ? null : `This copy isn't running ${name}: start it first. Sharing never starts anything.`;
}

// ---- what a row offers (§app.project-services/services-ui) -----------------------------------------

/**
 * The verbs a copy's row offers, by its state: Start while stopped, absent or degraded; Stop while running
 * or degraded; Apply and Reset always; Teardown never on main (slot 0). An adopted main offers Apply alone.
 */
export function rowVerbs(c: Pick<CopyView, "slot" | "state" | "adopted" | "services">): RowVerb[] {
  if (adoptedOf(c)) return ["apply"];
  const out: RowVerb[] = [];
  if (c.state === "stopped" || c.state === "absent" || c.state === "degraded") out.push("up");
  if (c.state === "running" || c.state === "degraded") out.push("down");
  out.push("apply", "reset");
  if (c.slot !== 0) out.push("teardown");
  return out;
}

/** Share is offered only on a running copy (the chosen endpoint's own readiness is checked in the form). */
export const shareOffered = (c: Pick<CopyView, "slot" | "state" | "adopted" | "services">): boolean => c.state === "running" && !adoptedOf(c);

/** The copy's chip: Starting while it is degraded only because a service is still starting. */
export function copyChip(state: InstanceState, starting: boolean): { word: string; tone?: ChipTone } {
  return starting ? { word: "Starting", tone: "info" } : COPY_CHIP[state];
}

/**
 * The unit an adopted main runs as: the server's `adopted`, else (a server older than that field, a peer's
 * included) the slot-0 service whose status detail says it is an adopted unit.
 */
export function adoptedOf(c: Pick<CopyView, "slot" | "adopted" | "services">): string | null {
  if (c.adopted) return c.adopted;
  if (c.slot !== 0) return null;
  return c.services.find((s) => s.unit && s.detail?.startsWith("adopted unit"))?.unit ?? null;
}

/** The line under an adopted main's row. */
export const adoptedLine = (unit: string): string => `Runs as ${unit}; Apply schedules a guarded restart.`;
