import type { ModelCheckStatus } from "../../shared/protocol";
import { clockTime } from "./format";

/** How long a model the check added carries its New mark (the server's NEW_FOR_MS). */
export const NEW_FOR_MS = 7 * 24 * 60 * 60 * 1000;

/** "just now", "5 minutes ago", "2 hours ago", "3 days ago". */
export function agoWords(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "just now";
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"} ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return unit(m, "minute");
  const h = Math.floor(m / 60);
  if (h < 24) return unit(h, "hour");
  return unit(Math.floor(h / 24), "day");
}

/** "3 new, 1 retired", "no changes". */
export function changesWords(added: number, retired: number): string {
  const parts = [added ? `${added} new` : "", retired ? `${retired} retired` : ""].filter(Boolean);
  return parts.length ? parts.join(", ") : "no changes";
}

/**
 * Settings → Models' line about the server's last check of Ollama Cloud's list
 * (§app.model-levels/settings-line): "Checking…", "Not checked yet", "Checked 2 hours ago · 3 new,
 * 1 retired", or "Last check failed 5 minutes ago: {reason}. Retrying at 4:30 PM.".
 */
export function checkLine(status: ModelCheckStatus | undefined, now: number, checking = false): string {
  if (checking || status?.checking) return "Checking…";
  const last = status?.last;
  if (!last) return "Not checked yet";
  if (last.ok) return `Checked ${agoWords(last.at, now)} · ${changesWords(last.added.length, last.retired.length)}${keyWords(last.key)}`;
  const reason = (last.error ?? "unknown error").replace(/[.\s]+$/, "");
  const retry = status?.enabled && last.retryAt ? ` Retrying at ${clockTime(last.retryAt)}.` : "";
  return `Last check failed ${agoWords(last.at, now)}: ${reason}.${keyWords(last.key, true)}${retry}`;
}

/** The same round's key check, as Settings → Accounts' Ollama Cloud tab reads it; nothing while the key was accepted. */
function keyWords(key: NonNullable<ModelCheckStatus["last"]>["key"], sentence = false): string {
  if (!key || key.result === "accepted") return "";
  const what = key.result === "refused" ? "the API key was refused" : "the API key couldn't be checked";
  return sentence ? ` ${what[0]!.toUpperCase()}${what.slice(1)}.` : ` · ${what}`;
}

/** The refs Settings → Models marks New: added by a check less than a week ago. */
export function newRefs(status: ModelCheckStatus | undefined, now: number): Set<string> {
  return new Set((status?.newModels ?? []).filter((m) => now - m.firstSeenAt < NEW_FOR_MS).map((m) => m.ref));
}
