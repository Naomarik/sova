import type { ChatClaudeLogin, ClaudeAccountsInfo, ClaudeLoginIdentity, ClaudeLoginStanding } from "../../shared/protocol";
import { accountGroups, loginName, type LoginFacts } from "./claude-login-groups";
import { formatTokens, type ContextState } from "./context";
import { modelProvider, stampTime } from "./format";

/** The Claude Code provider's model prefix (pi-config claude-code provider CLAUDE_PROVIDER_ID). */
const CLAUDE_PROVIDER = "claude-code-cli";

/** The part of an email before its @ (a phone's foot has room for that only), else the whole text. */
const beforeAt = (text: string) => (text.includes("@") ? text.slice(0, text.indexOf("@")) || text : text);

/**
 * The composer foot's login indicator (§app.claude-logins/active-login): shown only on a Claude
 * Code model, and only when this host has more than one login to choose from. `text` is the
 * compact part (the email, else the login's name; `short`, the part before its @, on a phone); `title` says whether the chat already runs on
 * it or will start on it. While a pick waits (§app.claude-logins/switch-queue) it shows the pick:
 * after the reply when one is `running`, else while it lands (a borrow).
 */
export function composerLogin(
  login: ChatClaudeLogin | null,
  modelRef: string | null,
  running = false,
): { text: string; short: string; title: string; label: string; pending: boolean } | null {
  if (!login || !login.several || modelProvider(modelRef) !== CLAUDE_PROVIDER) return null;
  const pick = login.pending;
  if (pick) {
    const when = running ? " after this reply" : "";
    return {
      text: pick.name,
      short: beforeAt(pick.name),
      title: `Switching to ${pick.name}${when}.${running ? " Open to cancel." : ""}`,
      label: `Claude login: switching to ${pick.name}${when}`,
      pending: true,
    };
  }
  const text = login.email ?? login.name;
  // A phone's foot has room for the part before the @ only.
  const short = login.email ? beforeAt(login.email) : text;
  const who = [login.name !== text ? login.name : null, text, login.planLabel].filter(Boolean).join(" · ");
  const how = login.recorded ? "This chat runs on this Claude login" : "This chat starts on this Claude login (first ready on this device)";
  return { text, short, title: `${how}: ${who}. Order and standing: Settings → Accounts.`, label: `Claude login: ${text}`, pending: false };
}

// ---- The login panel (§app.claude-logins/switch-login) ------------------------------------------

/** One row of the login panel. `reason` is why it can't be picked (null: it can). */
export interface LoginMenuRow {
  id: string;
  name: string;
  /** The chat's login. */
  checked: boolean;
  /** The pick waiting for the reply to end (or landing). */
  pending: boolean;
  /** Free at the keeper: picking it borrows it. */
  borrow: boolean;
  reason: string | null;
  /** Muted, after the name: the reason, "Borrow", "After this reply", or the own login's email. */
  meta: string | null;
}
export interface LoginMenuGroup {
  key: string;
  /** The account's email, else "Unknown account"; "This device" for the own login. */
  label: string;
  rows: LoginMenuRow[];
}

interface Candidate extends LoginFacts {
  identity: ClaudeLoginIdentity | null;
  reason: string | null;
  borrow: boolean;
}

function standingReason(standing: ClaudeLoginStanding, now: number): string | null {
  if (standing.state === "auth") return "Sign in again";
  if (standing.state === "limited" && standing.until > now) return `Limited until ${stampTime(standing.until, now)}`;
  return null;
}

/**
 * The login panel's groups: every login this device knows of, one group per account, the device's
 * own login last in "This device". Held here: pickable unless leaving, off, not signed in, needing
 * sign-in or limited. With the mesh on, the pool's other logins: free at the keeper ones are
 * borrowed on a pick; the rest say where they are. With the mesh off, logins assigned to another
 * device say which. `running`: a pick now waits for the reply to end.
 */
export function loginMenu(info: ClaudeAccountsInfo, chat: ChatClaudeLogin | null, running = false, now = Date.now()): LoginMenuGroup[] {
  const pool = info.pool;
  const here = new Set(info.logins.map((l) => l.id));
  const deviceLabel = (id: string | null) => (id ? (pool?.devices.find((d) => d.id === id)?.label ?? id) : "no device");
  const candidates: Candidate[] = [];
  let own: Candidate | null = null;
  for (const l of info.logins) {
    const leaving = pool?.logins.find((p) => p.id === l.id)?.moving?.op === "leave";
    const reason = leaving
      ? "Leaving this device"
      : !l.enabled
        ? "Off"
        : l.id !== "default" && !l.signedIn
          ? "Not signed in"
          : standingReason(l.standing, now);
    const c: Candidate = { id: l.id, label: l.label, addedAt: l.addedAt, account: l.identity?.accountUuid, identity: l.identity, reason, borrow: false };
    if (l.id === "default") own = c;
    else candidates.push(c);
  }
  if (pool) {
    for (const p of pool.logins) {
      if (here.has(p.id)) continue;
      const h = p.holder;
      // A login this device holds shows up in `logins` once its registry catches up.
      if (!h.free && h.device === pool.self) continue;
      const reason = !h.free
        ? `${h.stuck ? "Stuck on" : "On"} ${h.label}`
        : p.pin && p.pin !== pool.self
          ? `Pinned to ${deviceLabel(p.pin)}`
          : !pool.keeper.up
            ? "Keeper offline"
            : !p.enabled
              ? "Off"
              : standingReason(p.standing, now);
      candidates.push({ id: p.id, label: p.label, addedAt: p.addedAt, account: p.identity?.accountUuid, identity: p.identity, reason, borrow: reason === null });
    }
  } else {
    for (const e of info.elsewhere) {
      if (here.has(e.id)) continue;
      candidates.push({ id: e.id, label: e.label, account: e.identity?.accountUuid, identity: e.identity, reason: `On ${deviceLabel(e.device)}`, borrow: false });
    }
  }
  const row = (c: Candidate, account: readonly Candidate[]): LoginMenuRow => {
    const checked = chat?.id === c.id;
    const pending = chat?.pending?.id === c.id;
    const meta = pending ? (running ? "After this reply" : c.borrow ? "Borrowing…" : "Switching…") : c.reason ?? (c.borrow ? "Borrow" : c.id === "default" ? (c.identity?.email ?? null) : null);
    return { id: c.id, name: loginName(c, account), checked, pending, borrow: c.borrow, reason: c.reason, meta };
  };
  const groups: LoginMenuGroup[] = accountGroups(candidates, (c) => c).map((g) => ({
    key: g.key,
    label: g.logins.find((l) => l.identity?.email)?.identity?.email ?? "Unknown account",
    rows: g.logins.map((c) => row(c, g.logins)),
  }));
  if (own) groups.push({ key: "default", label: "This device", rows: [row(own, [own])] });
  return groups;
}

/**
 * The login panel's closing note (§app.claude-logins/switch-cost): what a switch resends uncached,
 * from the chat's context fill. None before the chat's first reply; no number after a compaction.
 */
export function resendNote(context: ContextState | undefined): { text: string; title: string } | null {
  const title = "An estimate from the last reply's context. The restart folds the history into one message, which the new login reads uncached.";
  if (context === "compacted") return { text: "Switching resends this chat without cache", title };
  if (!context || !(context.tokens > 0)) return null;
  return { text: `Switching resends ~${formatTokens(context.tokens)} tokens without cache`, title };
}
