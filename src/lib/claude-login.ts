import type { ChatClaudeLogin } from "../../shared/protocol";
import { modelProvider } from "./format";

/** The Claude Code provider's model prefix (pi-config claude-code provider CLAUDE_PROVIDER_ID). */
const CLAUDE_PROVIDER = "claude-code-cli";

/**
 * The composer foot's login indicator (§app.claude-logins/active-login): shown only on a Claude
 * Code model, and only when this host has more than one login to choose from. `text` is the
 * compact part (the email, else the login's name; `short`, the part before its @, on a phone); `title` says whether the chat already runs on
 * it or will start on it.
 */
export function composerLogin(login: ChatClaudeLogin | null, modelRef: string | null): { text: string; short: string; title: string; label: string } | null {
  if (!login || !login.several || modelProvider(modelRef) !== CLAUDE_PROVIDER) return null;
  const text = login.email ?? login.name;
  // A phone's foot has room for the part before the @ only.
  const short = login.email ? login.email.slice(0, login.email.indexOf("@")) || login.email : text;
  const who = [login.name !== text ? login.name : null, text, login.planLabel].filter(Boolean).join(" · ");
  const how = login.recorded ? "This chat runs on this Claude login" : "This chat starts on this Claude login (first ready on this device)";
  return { text, short, title: `${how}: ${who}. Order and standing: Settings → Accounts.`, label: `Claude login: ${text}` };
}
