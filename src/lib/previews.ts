import { FORBIDDEN_PREVIEW_PORTS } from "../../shared/public-links";
import { PREVIEW_WARNING, type PreviewView } from "../../shared/preview-links";

/**
 * The Previews card's words and checks (§mesh.public/preview-card). Pure: the card and the Shares
 * page render what these return.
 */

/** The expiry choices the New Preview form offers, in days. */
export const PREVIEW_EXPIRY_CHOICES = [1, 7, 30] as const;

/** The form's warning for a port (or the one being typed). */
export const previewWarning = (port: number | null): string => PREVIEW_WARNING.replaceAll("{n}", port === null ? "N" : String(port));

/** Whether something listens on the preview's port, as the card says it. */
export const runningLine = (v: PreviewView): string => (v.running ? "App is running" : `Nothing on port ${v.port}`);
/** A person's own link to another preview, sent to them on WhatsApp (§app.outreach/links): "sent to {name}", else null. */
export const sentToLine = (v: Pick<PreviewView, "siblingOf" | "sentToName">): string | null => (v.siblingOf ? `sent to ${recipientName(v)}` : null);

/** The previews the card and the Shares page list: active ones, soonest to expire last. */
export function activePreviews(list: readonly PreviewView[]): PreviewView[] {
  return list.filter((v) => v.state === "active").sort((a, b) => Date.parse(b.expiresAt) - Date.parse(a.expiresAt));
}

/** One row of the card or the Shares page: a preview and the people it was sent to (its active siblings, oldest first). */
export interface PreviewGroup {
  preview: PreviewView;
  recipients: PreviewView[];
}

/** The rows the card and the Shares page list: each active original with its active siblings under it; a sibling whose
    original isn't listed (off, expired or gone) keeps a row of its own. Soonest to expire last, like `activePreviews`. */
export function previewGroups(list: readonly PreviewView[]): PreviewGroup[] {
  const active = activePreviews(list);
  const listed = new Set(active.filter((v) => !v.siblingOf).map((v) => v.id));
  const recipients = new Map<string, PreviewView[]>();
  const groups: PreviewGroup[] = [];
  for (const v of active) {
    if (v.siblingOf && listed.has(v.siblingOf)) {
      const under = recipients.get(v.siblingOf) ?? [];
      under.push(v);
      recipients.set(v.siblingOf, under);
    } else groups.push({ preview: v, recipients: [] });
  }
  for (const g of groups) g.recipients = (recipients.get(g.preview.id) ?? []).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  return groups;
}

/** A recipient as the Sent to line names them. */
export const recipientName = (v: Pick<PreviewView, "sentToName">): string => v.sentToName?.trim() || "a person";

/* A preview's Delete, on the Previews card and the Shares page alike: a deleted link answers 410
   from then on and nothing brings it back, while the app on its port keeps running. */
/** A preview's own Delete, which ends every link sent from it too: its listed recipients' links counted in the label. */
export const deleteLabel = (recipients: number): string => (recipients > 0 ? `Delete Preview + ${recipients} ${recipients === 1 ? "Link" : "Links"}` : "Delete Preview");
export const DELETE_CONFIRM = "Delete for Good?";
export const DELETE_ALL_TIP = "Deletes this preview and every link sent from it.";
/** The line shown while a Delete waits for its second click. */
export const deleteNote = (recipients: number): string =>
  `${recipients > 0 ? `This link and the ${recipients} sent from it stop` : "The link stops"} working for good. Your app keeps running; make a New Preview to share it again.`;
export const PREVIEW_DELETED = "Preview deleted.";
export const deleteFailed = (why: string): string => `Couldn't delete it. ${why}`;
/** A recipient's own Delete, on their Sent to line: short to see, their name to hear. */
export const RECIPIENT_DELETE_LABEL = "Delete Link";
export const recipientDeleteName = (name: string): string => `Delete ${name}'s Link`;
export const recipientDeleteTip = (name: string): string => `Deletes only ${name}'s link.`;
export const recipientDeleteConfirm = (name: string): string => `Delete ${name}'s Link for Good?`;
export const recipientDeleteNote = (name: string): string => `${name}'s link stops working for good.`;
export const recipientDeleted = (name: string): string => `${name}'s link deleted.`;

/** The port field: a number the server would take, or what's wrong with it. Sova's own defaults
    are refused here too; the server also refuses whatever this host binds. */
export function parsePort(text: string): { port: number } | { error: string } {
  const t = text.trim();
  if (!/^\d{1,5}$/.test(t)) return { error: "Enter the port the app listens on, like 5173." };
  const port = Number(t);
  if (port < 1 || port > 65535) return { error: "A port is a number from 1 to 65535." };
  if (FORBIDDEN_PREVIEW_PORTS.includes(port)) return { error: `Port ${port} is Sova's own, so it can't be previewed.` };
  return { port };
}
