// One Needs you row, whatever it is about (§app.session-list/needs-you): where it is, a state chip that always says a
// word, what it is, one line of why, and what opening it does. Pure, so the rules run under tsx --test. The table is a
// Record of every digest kind: a new kind doesn't compile until it has its word.

import type { AttentionItem, AttentionKind, SessionSummary } from "../../shared/protocol";
import { tildePath } from "./format";
import type { NeedsYouRow } from "./needs-you";
import { orgPlaceLabel } from "./org-region";
import { heldWaitLine } from "./pipeline-view";

export type NeedsTone = "error" | "warn" | "success" | "info" | "accent" | undefined;

interface KindWords {
  /** The chip's word. */
  word: string;
  tone: NeedsTone;
  /** A row of no session: what it is about. Absent: the item's own title (an owner's request), or the session's. */
  title?: string;
  /** What opening the row does; absent: Open Chat. */
  action?: string;
}

const OPEN_PROJECT = "Open Project";
const OPEN_RELEASE = "Open Release";
const OPEN_REQUEST = "Open Request";

/** Every kind's chip and words. Failed is the one error word of a step; Your turn waits on you and on nothing else. */
export const NEEDS_KINDS: Record<AttentionKind, KindWords> = {
  "needs-input": { word: "Your turn", tone: "warn" },
  error: { word: "Failed", tone: "error" },
  "worker-error": { word: "Failed", tone: "error" },
  finished: { word: "Finished", tone: undefined },
  draft: { word: "Draft", tone: undefined },
  queued: { word: "Queued", tone: undefined },
  "context-full": { word: "Nearly full", tone: "warn" },
  working: { word: "Working", tone: "accent" },
  stale: { word: "Quiet", tone: undefined },
  "open-questions": { word: "Question", tone: "info" },
  looping: { word: "Looping", tone: "warn" },
  "baton-needs-you": { word: "Your turn", tone: "warn" },
  "roster-proposal": { word: "Your turn", tone: "warn" },
  "project-stakeholder": { word: "Your turn", tone: "warn", title: "Pick a main stakeholder", action: OPEN_PROJECT },
  "held-act": { word: "Held", tone: "warn", title: "Waiting to start", action: OPEN_PROJECT },
  "offer-waiting": { word: "Your turn", tone: "warn" },
  "card-waiting": { word: "Your turn", tone: "warn" },
  "tour-sign-in": { word: "Sign in", tone: "warn" },
  "playbook-review": { word: "Ready", tone: "success", action: "Read Report" },
  "deploy-failed": { word: "Failed", tone: "error", title: "Deploy failed", action: "Open Deploy" },
  "deploy-request": { word: "Asked", tone: "warn", title: "Asked to deploy", action: "Open Deploy" },
  "release-ready": { word: "Ready", tone: "success", title: "Ready to publish", action: "Review and Publish" },
  "release-request": { word: "Asked", tone: "warn", title: "Asked to release", action: OPEN_RELEASE },
  "release-quiet": { word: "Quiet", tone: "warn", title: "Release chat gone quiet", action: OPEN_RELEASE },
  "release-held": { word: "Your turn", tone: "warn", title: "Release step held", action: OPEN_RELEASE },
  "release-failed": { word: "Failed", tone: "error", title: "Release step failed", action: OPEN_RELEASE },
  "outreach-not-sent": { word: "Not sent", tone: "error", title: "Message not sent", action: "Open Person" },
  "whatsapp-down": { word: "Down", tone: "error", title: "Sending is down", action: "Open Outreach Settings" },
  "conflict-to-operator": { word: "Your turn", tone: "warn", title: "Settle a conflict", action: OPEN_PROJECT },
  "asks-you": { word: "Question", tone: "info" },
  unverified: { word: "Unchecked", tone: "info" },
  "ready-to-merge": { word: "Ready", tone: "success" },
  "merged-open-work": { word: "Open work", tone: "info" },
  "restart-pending": { word: "Restart", tone: "info", title: "Restart waiting", action: OPEN_PROJECT },
  "team-stalled": { word: "Quiet", tone: "warn" },
  "owner-request": { word: "Request", tone: "warn", action: OPEN_REQUEST },
  "owner-outage": { word: "Outage", tone: "error", action: OPEN_REQUEST },
  "owner-link-request": { word: "Request", tone: "warn", action: "Open People" },
  "owner-version-request": { word: "Request", tone: "warn", action: "Open Branches" },
  "owner-request-closed": { word: "Closed", tone: undefined, action: OPEN_REQUEST },
  "owner-feature-ended": { word: "Ended", tone: "warn", action: OPEN_REQUEST },
};

/** One row, ready to draw. */
export interface NeedsRow {
  key: string;
  /** Where it is: the project, the org and project, or the folder. */
  name: string;
  /** The folder it is in, for the tooltip and to tell same-named projects apart; null: not a folder. */
  place: string | null;
  chip: { word: string; tone: NeedsTone };
  title: string;
  /** "Untitled": drawn muted, as the session list does. */
  titleMuted?: boolean;
  detail: string;
  /** Every sentence, for the tooltip. */
  detailTip: string;
  action: string;
  href: string;
  /** A chat's path: the row is current while it's open. */
  sessionPath?: string;
}

const folderName = (p: string): string => p.replace(/\/+$/, "").split("/").pop() || p;
const isFolder = (s: string): boolean => s.startsWith("/") || s.startsWith("~");

/** A session's row: its project or folder, its title, the digest's sentence; Open Chat. */
export function sessionRow(r: NeedsYouRow, o: { href: string; home: string | null; host?: string | null; detail?: { text: string; title: string } | null }): NeedsRow {
  const s: SessionSummary = r.session;
  const k = NEEDS_KINDS[r.kind];
  const where = s.org ? orgPlaceLabel(s) : (s.project?.projectName ?? (s.cwd ? folderName(s.cwd) : "This host"));
  const text = o.detail?.text ?? r.detail ?? "";
  return {
    key: s.path,
    name: o.host ? `${where} · ${o.host}` : where,
    place: s.cwd ? tildePath(s.cwd, o.home) : null,
    chip: { word: k.word, tone: k.tone },
    title: s.title,
    ...(s.title === "Untitled" ? { titleMuted: true } : {}),
    detail: text,
    detailTip: o.detail?.title ?? r.details.join(" "),
    action: k.action ?? "Open Chat",
    href: o.href,
    sessionPath: s.path,
  };
}

/** A row's detail after its title: the title isn't said twice ("Ready to publish · v0.4.0" under "Ready to publish"). */
function afterTitle(detail: string, title: string): string {
  return detail.startsWith(`${title} · `) ? detail.slice(title.length + 3) : detail;
}

/** A failed Publish is titled as the Releases tab says it, and its reason keeps the line: "v0.4.0: origin refused". */
function failedPublish(it: AttentionItem): { title: string; detail: string } | null {
  const m = it.kind === "release-failed" ? /^(.+?): Publish failed(?:: (.*))?$/s.exec(it.detail ?? "") : null;
  return m ? { title: "Publish failed", detail: m[2] ? `${m[1]}: ${m[2]}` : m[1]! } : null;
}

/** A row of no session. An owner's item has the request as its title and lives under its org and project; any other's
    title is the project's name, and the kind says what it is. A held act names what waits and recounts its minutes. */
export function itemRow(it: AttentionItem, o: { home: string | null; now: number }): NeedsRow {
  const k = NEEDS_KINDS[it.kind];
  const held = it.held;
  const place = isFolder(it.where) ? tildePath(it.where, o.home) : null;
  const inOrg = it.org?.projectName ? `${it.org.orgName} · ${it.org.projectName}` : null;
  const publish = failedPublish(it);
  const title = held ? held.what.replace(/[.]$/, "") : (publish?.title ?? k.title ?? it.title);
  const name = k.title ? (inOrg ?? it.title) : (inOrg ?? it.where);
  const sentence = held ? heldWaitLine(held, o.now) : (it.detail ?? "");
  const detail = publish?.detail ?? afterTitle(sentence, title);
  return { key: it.id, name, place, chip: { word: k.word, tone: k.tone }, title, detail, detailTip: sentence, action: k.action ?? OPEN_PROJECT, href: it.href };
}

/**
 * What each row's name reads, when two listed projects share a name: "Notes · work/notes". Only as much of the path as
 * tells them apart, and only among rows in different folders (two items of one project are one project). A row with no
 * folder keeps its name. Returns the labels by row key.
 */
export function rowLabels(rows: readonly Pick<NeedsRow, "key" | "name" | "place">[]): Map<string, string> {
  const out = new Map(rows.map((r) => [r.key, r.name]));
  const byName = new Map<string, Set<string>>();
  for (const r of rows) if (r.place) byName.set(r.name, (byName.get(r.name) ?? new Set()).add(r.place.replace(/\/+$/, "")));
  for (const r of rows) {
    const places = [...(byName.get(r.name) ?? [])];
    if (!r.place || places.length < 2) continue;
    const parts = places.map((p) => p.split("/").filter(Boolean));
    const tail = (p: string[], n: number) => p.slice(-n).join("/");
    const most = Math.max(...parts.map((p) => p.length));
    let n = 1;
    while (n < most && new Set(parts.map((p) => tail(p, n))).size < parts.length) n++;
    out.set(r.key, `${r.name} · ${tail(r.place.replace(/\/+$/, "").split("/").filter(Boolean), n)}`);
  }
  return out;
}
