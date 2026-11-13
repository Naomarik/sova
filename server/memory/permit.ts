// The server's side of a web-only minor mode (§chat.memory/where): Sova's mode engine takes `/mode memory on`
// only while this process is applying a switch for that very session, through the `sova:web-minor` hook
// (minor.ts WEB_MINOR_HOOK). Typed by hand, from a terminal, or from --minor, it is refused.
import { WEB_MINOR_HOOK, type MinorMode } from "../../pi-config/extensions/mode/minor.ts";
import { WEB_MODE_HOOK, type Mode } from "../../pi-config/extensions/mode/state.ts";

const applying = new Map<string, Set<MinorMode>>();
const applyingMode = new Map<string, Mode>();

function install(): void {
  const g = globalThis as Record<symbol, unknown>;
  if (typeof g[WEB_MODE_HOOK] !== "function") g[WEB_MODE_HOOK] = (sessionId: string, mode: Mode): boolean => applyingMode.get(sessionId) === mode;
  if (typeof g[WEB_MINOR_HOOK] === "function") return;
  g[WEB_MINOR_HOOK] = (sessionId: string, minor: MinorMode): boolean => applying.get(sessionId)?.has(minor) ?? false;
}
// Installed at load, before any chat starts: its presence is how the mode engine knows it runs inside Sova's
// server, where a chat adopting a saved default with memory keeps it (a terminal drops it).
install();

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

/** Call `fn` (the chat's own /mode handler) with `mode` permitted in `sessionId`. The extension checks it before
    its first await, so the permit ends when `fn` returns, not when its routing probe does. */
export function withWebMode<T>(sessionId: string, mode: Mode, fn: () => T): T {
  install();
  applyingMode.set(sessionId, mode);
  try {
    return fn();
  } finally {
    applyingMode.delete(sessionId);
  }
}
