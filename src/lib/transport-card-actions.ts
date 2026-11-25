// The Transport agent card's one action row (components/TransportAgentCard.tsx): which buttons it shows, in
// which order, their words, and which one is primary. DOM- and Solid-free, so a unit test reads it.
import { entryHref } from "./services-view";

/** The arrived chat's running copy as the card reads it (transport-api.ts TransportCopyView). */
interface CopyRead {
  state: "waiting" | "starting" | "running" | "failed" | "none";
  copies: { entry?: { port: number; path: string } }[];
}

/**
 * Open App's link (§app.transport/agent "Ready means the app runs"): the running copy's entry page on the host this page
 * was opened from, only once the card reads Ready and the copy runs; null otherwise (a copy still starting, failed, or
 * none started). Pure.
 */
export function openAppHref(at: { ready: boolean; copy: CopyRead | null | undefined; host: string }): string | null {
  if (!at.ready || at.copy?.state !== "running") return null;
  const e = at.copy.copies.find((c) => c.entry)?.entry;
  return e ? entryHref(at.host, e) : null;
}

export type TransportCardAction =
  | { kind: "allow"; id: string; label: string; primary: boolean }
  | { kind: "done"; id: string; label: string; primary: boolean }
  | { kind: "bring"; id: string; label: string; primary: boolean }
  | { kind: "placed"; id: string; label: string; primary: boolean }
  | { kind: "save"; label: string; primary: boolean }
  | { kind: "app"; href: string; label: string; primary: boolean }
  | { kind: "open"; href: string; label: string; primary: false };

/**
 * The row: what the agent asks you first (Allow Downloads, a Done per command, Bring From {device} and I Placed It
 * Myself per file, Save Values), then Open App once the running copy runs, then Open Agent Chat. The first answer is
 * the card's one primary; with nothing to answer Open App is; Open Agent Chat never is. With more than one command or
 * file, each button names its own by number, as its block does. Pure.
 */
export function transportCardActions(at: {
  downloads: string | null;
  commands: readonly string[];
  files?: readonly { id: string; from: string }[];
  hostValues: boolean;
  app?: string | null;
  href: string | null;
}): TransportCardAction[] {
  type Answer = Exclude<TransportCardAction, { kind: "open" } | { kind: "app" }>;
  const answers: Answer[] = [];
  if (at.downloads) answers.push({ kind: "allow", id: at.downloads, label: "Allow Downloads", primary: false });
  const many = at.commands.length > 1;
  at.commands.forEach((id, i) => answers.push({ kind: "done", id, label: many ? `Done With Command ${i + 1}` : "Done", primary: false }));
  const files = at.files ?? [];
  const manyFiles = files.length > 1;
  files.forEach((f, i) => {
    answers.push({ kind: "bring", id: f.id, label: manyFiles ? `Bring File ${i + 1} From ${f.from}` : `Bring From ${f.from}`, primary: false });
    answers.push({ kind: "placed", id: f.id, label: manyFiles ? `I Placed File ${i + 1}` : "I Placed It Myself", primary: false });
  });
  if (at.hostValues) answers.push({ kind: "save", label: "Save Values", primary: false });
  if (answers[0]) answers[0] = { ...answers[0], primary: true };
  const app: TransportCardAction[] = at.app ? [{ kind: "app", href: at.app, label: "Open App", primary: !answers.length }] : [];
  return [...answers, ...app, ...(at.href ? [{ kind: "open" as const, href: at.href, label: "Open Agent Chat", primary: false as const }] : [])];
}
