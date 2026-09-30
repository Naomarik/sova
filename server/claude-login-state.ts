import { getAgentDir } from "@earendil-works/pi-coding-agent";
// The claude-code extension's own registry and its session entry (node built-ins only). See CLAUDE.md.
import { ClaudeLogins, CLAUDE_LOGIN_ENTRY, planLabel } from "../pi-config/extensions/claude-code/accounts.ts";
import type { ChatClaudeLogin, ChatServerMessage } from "../shared/protocol";
import { poolAgent } from "./claude-pool/index";

// A chat's Claude login (§app.claude-logins/active-login): the login its newest `claude-login`
// entry names, which the provider writes when the session's child first starts and at every
// switch; before that, the login this host would start it on now (its first usable login).

type Entry = { type?: unknown; customType?: unknown; data?: unknown };

/** The newest `claude-login` entry's data on a branch (oldest first), as recordedLogin reads it. */
function newestLoginEntry(branch: readonly Entry[]): { login: string; label?: string } | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i]!;
    const d = e.data as { login?: unknown; label?: unknown } | undefined;
    if (e.type === "custom" && e.customType === CLAUDE_LOGIN_ENTRY && typeof d?.login === "string")
      return { login: d.login, ...(typeof d.label === "string" && d.label ? { label: d.label } : {}) };
  }
  return undefined;
}

let hostLogins: ClaudeLogins | null = null;

/** The pool's logins (mesh on) that are not in `order`, i.e. not on this device; none while the mesh is off. */
function othersInPool(order: readonly string[]): number {
  const doc = poolAgent()?.doc();
  if (!doc) return 0;
  return Object.entries(doc.logins).filter(([id, l]) => !l.removed.value && !order.includes(id)).length;
}

/** What the chat message adds to the registry's reading: a pick waiting for the reply to end. */
export interface ChatLoginExtra {
  pending?: { id: string; name: string } | null;
  /** How many logins the pool has besides this device's order (tests pass their own). */
  poolOthers?: (order: readonly string[]) => number;
}

/** The chat's login, or null when the registry can't name one. Reads the registry; never touches a login's directory. */
export function chatClaudeLogin(branch: readonly Entry[], logins: ClaudeLogins = (hostLogins ??= new ClaudeLogins({ agentDir: getAgentDir() })), extra: ChatLoginExtra = {}): ChatClaudeLogin | null {
  try {
    const accounts = logins.accounts();
    const recorded = newestLoginEntry(branch);
    const id = recorded?.login ?? logins.selectId(undefined, accounts);
    const identity = logins.identityOf(id, accounts);
    const label = accounts.logins.find((l) => l.id === id)?.label;
    const plan = planLabel(identity);
    const order = logins.order(accounts);
    return {
      id,
      name: label ?? identity?.email ?? recorded?.label ?? id,
      ...(identity?.email ? { email: identity.email } : {}),
      ...(plan ? { planLabel: plan } : {}),
      recorded: !!recorded,
      // A device holding nothing but its own login still has the pool's to borrow from.
      several: order.length > 1 || (extra.poolOthers ?? othersInPool)(order) > 0,
      ...(extra.pending ? { pending: extra.pending } : {}),
    };
  } catch {
    return null;
  }
}

export const claudeLoginMessage = (branch: readonly Entry[], logins?: ClaudeLogins, extra?: ChatLoginExtra): ChatServerMessage => ({ type: "claude_login", login: chatClaudeLogin(branch, logins, extra) });

/**
 * After a hello: the chat's login only when this host has several to choose between, as the
 * sandbox message is sent only with its extension. Without one nothing is sent, and the client's
 * hello already cleared what it showed.
 */
export function claudeLoginAfterHello(branch: readonly Entry[], logins?: ClaudeLogins, extra?: ChatLoginExtra): ChatServerMessage | null {
  const login = chatClaudeLogin(branch, logins, extra);
  return login?.several ? { type: "claude_login", login } : null;
}

/**
 * The name the chat shows for a login it may be moved to: its label, else its email, from this
 * device's registry, else from the pool (a login free at the keeper), else its id.
 */
export function loginName(id: string, logins: ClaudeLogins = (hostLogins ??= new ClaudeLogins({ agentDir: getAgentDir() }))): string {
  try {
    const accounts = logins.accounts();
    const record = accounts.logins.find((l) => l.id === id);
    const pooled = poolAgent()?.doc().logins[id];
    return record?.label ?? logins.identityOf(id, accounts)?.email ?? pooled?.label.value ?? pooled?.identity?.email ?? (id === "default" ? "Claude Code's own login" : id);
  } catch {
    return id;
  }
}

export type LoginPickTarget = { id: string; name: string };

/**
 * A chat's pick of Claude login over its life (§app.claude-logins/switch-queue): made while a
 * reply runs it waits, a later pick replaces it, the chat's own login or a cancel drops it, and it
 * is applied when the reply ends. `applying` covers the landing (a borrow can take 30 s): no pick
 * or cancel then. Pure; ChatSession drives it and runs the switch.
 */
export class LoginPick {
  pending: LoginPickTarget | null = null;
  applying = false;

  /**
   * `pick` (null: cancel) against the chat's login `current`; `busy`: a reply (or a compaction)
   * runs. "apply": call start() and switch now. "landing": refused, one is landing.
   */
  choose(pick: LoginPickTarget | null, current: string | undefined, busy: boolean): "cancelled" | "unchanged" | "queued" | "apply" | "landing" {
    if (pick === null || pick.id === current) {
      if (!this.pending || this.applying) return "unchanged";
      this.pending = null;
      return "cancelled";
    }
    if (this.applying) return "landing";
    this.pending = pick;
    return busy ? "queued" : "apply";
  }

  /** The reply ended (or an idle pick): the pick to apply now, marked landing; null when none. */
  start(): LoginPickTarget | null {
    if (!this.pending || this.applying) return null;
    this.applying = true;
    return this.pending;
  }

  /** The switch for `pick` landed or failed: it no longer waits. */
  done(pick: LoginPickTarget): void {
    this.applying = false;
    if (this.pending === pick) this.pending = null;
  }
}

export const isClaudeLoginEntry = (entry: unknown): boolean =>
  !!entry && typeof entry === "object" && (entry as Entry).type === "custom" && (entry as Entry).customType === CLAUDE_LOGIN_ENTRY;
