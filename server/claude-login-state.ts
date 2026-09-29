import { getAgentDir } from "@earendil-works/pi-coding-agent";
// The claude-code extension's own registry and its session entry (node built-ins only). See CLAUDE.md.
import { ClaudeLogins, CLAUDE_LOGIN_ENTRY, planLabel } from "../pi-config/extensions/claude-code/accounts.ts";
import type { ChatClaudeLogin, ChatServerMessage } from "../shared/protocol";

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

/** The chat's login, or null when the registry can't name one. Reads the registry; never touches a login's directory. */
export function chatClaudeLogin(branch: readonly Entry[], logins: ClaudeLogins = (hostLogins ??= new ClaudeLogins({ agentDir: getAgentDir() }))): ChatClaudeLogin | null {
  try {
    const accounts = logins.accounts();
    const recorded = newestLoginEntry(branch);
    const id = recorded?.login ?? logins.selectId(undefined, accounts);
    const identity = logins.identityOf(id, accounts);
    const label = accounts.logins.find((l) => l.id === id)?.label;
    const plan = planLabel(identity);
    return {
      id,
      name: label ?? identity?.email ?? recorded?.label ?? id,
      ...(identity?.email ? { email: identity.email } : {}),
      ...(plan ? { planLabel: plan } : {}),
      recorded: !!recorded,
      several: logins.order(accounts).length > 1,
    };
  } catch {
    return null;
  }
}

export const claudeLoginMessage = (branch: readonly Entry[], logins?: ClaudeLogins): ChatServerMessage => ({ type: "claude_login", login: chatClaudeLogin(branch, logins) });

/**
 * After a hello: the chat's login only when this host has several to choose between, as the
 * sandbox message is sent only with its extension. Without one nothing is sent, and the client's
 * hello already cleared what it showed.
 */
export function claudeLoginAfterHello(branch: readonly Entry[], logins?: ClaudeLogins): ChatServerMessage | null {
  const login = chatClaudeLogin(branch, logins);
  return login?.several ? { type: "claude_login", login } : null;
}

export const isClaudeLoginEntry = (entry: unknown): boolean =>
  !!entry && typeof entry === "object" && (entry as Entry).type === "custom" && (entry as Entry).customType === CLAUDE_LOGIN_ENTRY;
