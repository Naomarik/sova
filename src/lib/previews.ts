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

/** The previews the card and the Shares page list: active ones, soonest to expire last. */
export function activePreviews(list: readonly PreviewView[]): PreviewView[] {
  return list.filter((v) => v.state === "active").sort((a, b) => Date.parse(b.expiresAt) - Date.parse(a.expiresAt));
}

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
