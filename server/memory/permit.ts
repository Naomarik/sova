// The server's side of a web-only minor mode (§chat.memory/where): the mode extension takes `/mode memory on`
// only while this process is applying a switch for that very session, through the `sova:web-minor` hook
// (minor.ts WEB_MINOR_HOOK). Typed by hand, from a terminal, or from --minor, it is refused.
import { WEB_MINOR_HOOK, type MinorMode } from "../../pi-config/extensions/mode/minor.ts";

const applying = new Map<string, Set<MinorMode>>();

function install(): void {
  const g = globalThis as Record<symbol, unknown>;
  if (typeof g[WEB_MINOR_HOOK] === "function") return;
  g[WEB_MINOR_HOOK] = (sessionId: string, minor: MinorMode): boolean => applying.get(sessionId)?.has(minor) ?? false;
}

/** Run `fn` (the chat's own /mode handler calls) with `minors` permitted in `sessionId`, and only then. */
export async function withWebMinors<T>(sessionId: string, minors: readonly MinorMode[], fn: () => Promise<T>): Promise<T> {
  install();
  if (minors.length === 0) return fn();
  const prev = applying.get(sessionId);
  applying.set(sessionId, new Set([...(prev ?? []), ...minors]));
  try {
    return await fn();
  } finally {
    if (prev) applying.set(sessionId, prev);
    else applying.delete(sessionId);
  }
}
