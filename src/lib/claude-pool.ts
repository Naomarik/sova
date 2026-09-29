import type { ClaudePoolDevice, ClaudePoolInfo, ClaudePoolLogin } from "../../shared/protocol";

// Words for the pool of Claude logins (§app.claude-logins/pool): Settings → Accounts' one list and
// the Mesh page's chip per device. Pure, so the words are tested where they are made.

export type ChipTone = "success" | "warn" | "error" | "info" | "accent" | undefined;

/** Where a login is, as its row's chip says it. */
export function holderChip(l: ClaudePoolLogin, self: string): { text: string; tone: ChipTone; title: string } {
  const h = l.holder;
  if (h.stuck) return { text: `Stuck on ${h.label}`, tone: "warn", title: `${h.label} is offline with this login. It frees when ${h.label} is back, or when you sign it in again on another device.` };
  if (h.free) return { text: "Free", tone: "success", title: `Kept by ${h.label} for any device that needs it.` };
  if (h.device === self) return { text: "This device", tone: "accent", title: "Every Claude process here runs on it." };
  return { text: h.label, tone: "info", title: `${h.label} is using it.` };
}

const REASONS: Record<string, string> = {
  limit: "hit its limit",
  auth: "sign-in failed",
  user: "asked to return",
  pin: "pinned to another device",
  idle: "idle for 30 minutes",
  keeper: "moving to the new keeper",
  removed: "removed",
  superseded: "signed in again elsewhere",
};

/** A move this device has under way for the login, in words; undefined when none. */
export function movingText(l: ClaudePoolLogin): string | undefined {
  const m = l.moving;
  if (!m) return l.returnAsked ? "Returning after the current turn" : undefined;
  if (m.op === "leave") {
    const why = m.reason ? REASONS[m.reason] ?? m.reason : "";
    if (m.state === "draining") return `Leaving this device (${why}): waiting for its Claude processes to finish`;
    if (m.state === "sending") return `Waiting for the keeper to take it back (${why})`;
    return "Leaving this device";
  }
  if (m.op === "borrow") return "Arriving here";
  return "Being lent";
}

/** "5h 42% · weekly 18%", or undefined when the holder has published nothing. */
export function usageText(l: ClaudePoolLogin): string | undefined {
  const u = l.usage;
  if (!u) return undefined;
  const parts: string[] = [];
  if (typeof u.fiveHour === "number") parts.push(`5h ${Math.round(u.fiveHour)}%`);
  if (typeof u.sevenDay === "number") parts.push(`weekly ${Math.round(u.sevenDay)}%`);
  return parts.length ? parts.join(" · ") : undefined;
}

/** Which actions a row offers. */
export function poolActions(l: ClaudePoolLogin): { returnable: boolean; signIn: boolean } {
  return {
    returnable: !l.holder.free && !l.holder.stuck && !l.returnAsked && l.moving?.op !== "leave",
    signIn: l.holder.stuck || l.standing.state === "auth",
  };
}

/** The Mesh page's chip for a device: the login(s) it holds, else "No login". */
export function deviceLoginChip(pool: ClaudePoolInfo, device: string): { text: string; title: string } {
  const d: ClaudePoolDevice | undefined = pool.devices.find((x) => x.id === device);
  const held = (d?.logins ?? []).map((id) => pool.logins.find((l) => l.id === id)).filter((l): l is ClaudePoolLogin => !!l);
  const name = (l: ClaudePoolLogin) => l.label ?? l.identity?.email ?? l.id;
  if (!held.length) {
    const keeps = pool.keeper.id === device ? " It is the keeper of the free logins." : "";
    return { text: "No Claude login", title: `Holds no pool login: it borrows one when it needs Claude, else uses its own Claude Code login.${keeps}` };
  }
  const first = name(held[0]!);
  return {
    text: held.length === 1 ? `Claude: ${first}` : `Claude: ${first} +${held.length - 1}`,
    title: `Holds ${held.map(name).join(", ")}.`,
  };
}
