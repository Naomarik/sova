import { ClaudeLogins, DEFAULT_LOGIN_ID, readAccounts } from "../pi-config/extensions/claude-code/accounts.ts";
import type { ClaudeLoginOption } from "../shared/projects";
import { poolAgent } from "./claude-pool/index";
import { isAssignableLogin } from "./claude-login-store";
import { agentRoot } from "./state-root";

/**
 * Whether a project or organization may be given login `id` here (§app.claude-logins/project-login):
 * this computer's own login, a login in its registry, or, with the mesh on, a login of the pool.
 */
export function knownLogin(id: unknown): id is string {
  if (!isAssignableLogin(id)) return false;
  if (id === DEFAULT_LOGIN_ID) return true;
  if (readAccounts(agentRoot()).value.logins.some((l) => l.id === id)) return true;
  try {
    const doc = poolAgent()?.doc();
    return !!doc?.logins[id] && !doc.logins[id]!.removed.value;
  } catch {
    return false;
  }
}

/** The refusal for a login no project may be given. */
export const UNKNOWN_LOGIN = "That Claude login isn't on this computer.";

/**
 * The logins a project or organization here may be given, as its Settings card lists them: this computer's own
 * login first, then each login in this device's order, then (mesh on) the pool's others; each by its email, else
 * its label, else its id.
 */
export function loginOptions(): ClaudeLoginOption[] {
  const logins = new ClaudeLogins({ agentDir: agentRoot() });
  const accounts = logins.accounts();
  const out: ClaudeLoginOption[] = [{ id: DEFAULT_LOGIN_ID, name: "This computer's own login" }];
  for (const id of logins.order(accounts)) {
    if (id === DEFAULT_LOGIN_ID) continue;
    const rec = accounts.logins.find((l) => l.id === id);
    out.push({ id, name: rec?.identity?.email ?? rec?.label ?? id });
  }
  try {
    const doc = poolAgent()?.doc();
    for (const [id, l] of Object.entries(doc?.logins ?? {}))
      if (!l.removed.value && !out.some((o) => o.id === id)) out.push({ id, name: l.identity?.email ?? l.label.value ?? id });
  } catch {
    /* the pool can't be read: this device's logins */
  }
  return out;
}
