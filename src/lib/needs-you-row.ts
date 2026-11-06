// One Needs you row, whatever it is about (§app.session-list/needs-you): where it is, a state chip that always says a
// word and what it is; why is hover text. Pure, so the rules run under tsx --test. The table is a
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
}

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
  "project-stakeholder": { word: "Your turn", tone: "warn", title: "Pick a main stakeholder" },
  "held-act": { word: "Held", tone: "warn", title: "Waiting to start" },
  "offer-waiting": { word: "Your turn", tone: "warn" },
  "card-waiting": { word: "Your turn", tone: "warn" },
  // A session pinged stuck or needs your decision (§app.overseer-pings/raised-hand); its done line never lists here.
  "raised-hand": { word: "Your turn", tone: "warn" },
  "tour-sign-in": { word: "Sign in", tone: "warn" },
  "playbook-review": { word: "Ready", tone: "success" },
  "deploy-failed": { word: "Failed", tone: "error", title: "Deploy failed" },
  "deploy-request": { word: "Asked", tone: "warn", title: "Asked to deploy" },
  "release-ready": { word: "Ready", tone: "success", title: "Ready to publish" },
  "release-request": { word: "Asked", tone: "warn", title: "Asked to release" },
  "release-quiet": { word: "Quiet", tone: "warn", title: "Release chat gone quiet" },
  "release-held": { word: "Your turn", tone: "warn", title: "Release step held" },
  "release-failed": { word: "Failed", tone: "error", title: "Release step failed" },
  "outreach-not-sent": { word: "Not sent", tone: "error", title: "Message not sent" },
  "whatsapp-down": { word: "Down", tone: "error", title: "Sending is down" },
  "conflict-to-operator": { word: "Your turn", tone: "warn", title: "Settle a conflict" },
  "asks-you": { word: "Question", tone: "info" },
  unverified: { word: "Unchecked", tone: "info" },
  "ready-to-merge": { word: "Ready", tone: "success" },
  "merged-open-work": { word: "Open work", tone: "info" },
  "restart-pending": { word: "Restart", tone: "info", title: "Restart waiting" },
  "team-stalled": { word: "Quiet", tone: "warn" },
  "owner-request": { word: "Request", tone: "warn" },
  "owner-outage": { word: "Outage", tone: "error" },
  "owner-link-request": { word: "Request", tone: "warn" },
  "owner-version-request": { word: "Request", tone: "warn" },
  "owner-request-closed": { word: "Closed", tone: undefined },
  "owner-feature-ended": { word: "Ended", tone: "warn" },
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
  /** The row's hover text: its whole title, then every sentence it has, newest first, a line each. */
  tip: string;
  href: string;
  /** A chat's path: the row is current while it's open. */
  sessionPath?: string;
}

const folderName = (p: string): string => p.replace(/\/+$/, "").split("/").pop() || p;
const isFolder = (s: string): boolean => s.startsWith("/") || s.startsWith("~");

const tipOf = (title: string, sentences: readonly string[]): string => [title, ...sentences.filter(Boolean)].join("\n");

/** A session's row: its project or folder, its title, its sentences as hover text. `sentences`: the Organizations region's,
    which say more than the digest's. */
export function sessionRow(r: NeedsYouRow, o: { href: string; home: string | null; host?: string | null; sentences?: readonly string[] }): NeedsRow {
  const s: SessionSummary = r.session;
  const k = NEEDS_KINDS[r.kind];
  const where = s.org ? orgPlaceLabel(s) : (s.project?.projectName ?? (s.cwd ? folderName(s.cwd) : "This host"));
  return {
    key: s.path,
    name: o.host ? `${where} · ${o.host}` : where,
    place: s.cwd ? tildePath(s.cwd, o.home) : null,
    chip: { word: k.word, tone: k.tone },
    title: s.title,
    ...(s.title === "Untitled" ? { titleMuted: true } : {}),
    tip: tipOf(s.title, o.sentences ?? r.details),
    href: o.href,
    sessionPath: s.path,
  };
}

/** A failed Publish is titled as the Releases tab says it. */
const publishFailed = (it: AttentionItem): boolean => it.kind === "release-failed" && /^.+?: Publish failed(?:: .*)?$/s.test(it.detail ?? "");

/** A row of no session. An owner's item has the request as its title and lives under its org and project; any other's
    title is the project's name, and the kind says what it is. A held act names what waits and recounts its minutes. */
export function itemRow(it: AttentionItem, o: { home: string | null; now: number }): NeedsRow {
  const k = NEEDS_KINDS[it.kind];
  const held = it.held;
  const place = isFolder(it.where) ? tildePath(it.where, o.home) : null;
  const inOrg = it.org?.projectName ? `${it.org.orgName} · ${it.org.projectName}` : null;
  const title = held ? held.what.replace(/[.]$/, "") : publishFailed(it) ? "Publish failed" : (k.title ?? it.title);
  const name = k.title ? (inOrg ?? it.title) : (inOrg ?? it.where);
  const sentence = held ? heldWaitLine(held, o.now) : (it.detail ?? "");
  return { key: it.id, name, place, chip: { word: k.word, tone: k.tone }, title, tip: tipOf(title, [sentence]), href: it.href };
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
