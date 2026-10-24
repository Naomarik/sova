import { DEFAULT_LOGIN_ID, readAccounts } from "../pi-config/extensions/claude-code/accounts.ts";
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
