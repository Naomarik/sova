import type { SubagentProfilesReplaced } from "../../shared/subagent-profiles";
import { stampTime } from "./format";

/**
 * The notice Settings → Subagents shows when another device's copy changed this library
 * (§chat.subagent-profiles/replaced): "Replaced by Zen's copy at 2:01 PM." when a profile here was
 * changed or removed, "Zen's copy added Fast at 2:01 PM." when it only added profiles.
 */
export function replacedNotice(r: SubagentProfilesReplaced, now = Date.now()): { title: string; body: string } {
  const at = stampTime(r.at, now);
  const c = r.changes;
  const onlyAdded = !!c && c.added.length > 0 && c.changed.length === 0 && c.removed.length === 0;
  const title = onlyAdded ? `${r.by}'s copy added ${c!.added.join(", ")} at ${at}.` : `Replaced by ${r.by}'s copy at ${at}.`;
  const parts = c
    ? [
        c.added.length ? `added ${c.added.join(", ")}` : "",
        c.changed.length ? `changed ${c.changed.join(", ")}` : "",
        c.removed.length ? `removed ${c.removed.join(", ")}` : "",
      ].filter(Boolean)
    : [];
  const what = parts.length && !onlyAdded ? `${parts.join("; ").replace(/^./, (s) => s.toUpperCase())}. ` : "";
  return { title, body: `${what}Your previous library is kept on this device.` };
}
