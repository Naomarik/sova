// Settings → Extensions' "Let {name} link computers without asking" (§mesh.lan/proposals): which extensions the
// person lets add and widen links to other computers with no dialog. `<state root>/extension-link-trust.json`
// (0600, written whole), outside every repository. Each trust is tied to what was approved when it was turned on
// (the approval's version and moment; on a list the server's environment names, the entry and its code as read), so
// approving the extension again, or a new version, turns it off for good, and while the row reads Changed (its
// code isn't what was approved) it does nothing. Remove forgets it. Read only when an extension proposes a link or
// the screen draws its rows; a server whose extensions never ask writes nothing.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { approvalOf, codeReadingOf, entryHash, trustDecided } from "./extension-gate";
import { listedExtension } from "./extensions";
import { stateRoot } from "./state-root";
import { writeFileAtomic } from "./sync/logins-stores";

export const linkTrustFile = (): string => join(stateRoot(), "extension-link-trust.json");

interface LinkTrustFile {
  version: 1;
  trusted: Record<string, { approval: string; at: string }>;
}

function read(): LinkTrustFile {
  try {
    const raw = JSON.parse(readFileSync(linkTrustFile(), "utf8")) as Partial<LinkTrustFile> | null;
    if (raw?.version === 1 && raw.trusted && typeof raw.trusted === "object" && !Array.isArray(raw.trusted)) return { version: 1, trusted: raw.trusted };
  } catch {
    // none, or unreadable: no extension is trusted
  }
  return { version: 1, trusted: {} };
}

function write(file: LinkTrustFile): void {
  mkdirSync(dirname(linkTrustFile()), { recursive: true });
  writeFileAtomic(linkTrustFile(), `${JSON.stringify(file, null, 2)}\n`);
}

/** What a trust is tied to now: the approval in force, or null when the extension isn't on as approved (waiting,
    Changed, off, gone), so nothing can be trusted. */
function approvalKey(id: string): string | null {
  const l = listedExtension(id);
  if (!l?.valid || l.state !== "on") return null;
  // A list the server's environment names counts as approved as it reads, with no approval kept: the trust is for the
  // entry and its code as the background pass last read them, so changed code reads as not trusted.
  if (process.env.SOVA_EXTENSIONS_FILE || !trustDecided()) return `list:${entryHash(l.raw)}:${codeReadingOf(id)?.code ?? ""}`;
  const a = approvalOf(id);
  return a ? `${a.version}@${a.at}` : null;
}

/** The person lets this extension link computers without asking, for the version now approved and on. */
export function linkTrusted(id: string): boolean {
  const t = read().trusted[id];
  if (!t) return false;
  const key = approvalKey(id);
  return key !== null && t.approval === key;
}

export class LinkTrustRefusal extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409,
  ) {
    super(message);
  }
}

/** The switch, from the person's own page (the route checks that). Off is always allowed; on needs the extension on. */
export function setLinkTrust(id: string, on: boolean): void {
  if (!listedExtension(id)) throw new LinkTrustRefusal("No such extension.", 404);
  if (!on) return forgetLinkTrust(id);
  const key = approvalKey(id);
  if (key === null) throw new LinkTrustRefusal("Turn this extension on, approved as it is now, first. Nothing changed.", 409);
  const file = read();
  write({ version: 1, trusted: { ...file.trusted, [id]: { approval: key, at: new Date().toISOString() } } });
}

/** Off (the switch, or the extension removed). Writes only when it was there. */
export function forgetLinkTrust(id: string): void {
  const file = read();
  if (!Object.hasOwn(file.trusted, id)) return;
  const trusted = { ...file.trusted };
  delete trusted[id];
  write({ version: 1, trusted });
}
