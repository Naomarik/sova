import { LOGIN_CONTEXT_ENV } from "../pi-config/extensions/claude-code/accounts.ts";
import { loginContextForCwd } from "./projects/claude-login";

/**
 * The variable a chat process starts with (§app.claude-logins/project-login): its project's Claude login
 * and the logins saved for other work, as accounts.ts loginContextFromEnv reads it. Empty when there is
 * nothing to hand over, or when it can't be worked out (the chat then keeps this computer's order).
 */
export function loginContextEnv(cwd: string): Record<string, string> {
  try {
    const ctx = loginContextForCwd(cwd);
    return ctx ? { [LOGIN_CONTEXT_ENV]: JSON.stringify(ctx) } : {};
  } catch (err) {
    console.warn(`[claude-login] no project login for ${cwd}: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}
