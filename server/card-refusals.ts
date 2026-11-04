/**
 * Credentials never pass through a Create card (§chat.create-mode/settings-cards). `credentialProblem` looks
 * through whatever a card would carry: a key named like a credential holding a value, and any string shaped like
 * one. An environment variable's name is a reference, not a secret, so `OPENAI_API_KEY` and `$OPENAI_API_KEY` pass;
 * pi's `!command` form does not, because it runs a command to fetch one.
 */

const CREDENTIAL_KEY = /(^key$|api[_-]?key|secret|token(?!iz)|passw|credential|bearer|authorization|private[_-]?key|cookie|oauth)/i;

const SECRET_SHAPES: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/, // OpenAI, Anthropic and their likes
  /\bgh[pousr]_[A-Za-z0-9]{20,}/, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{16,}/, // Slack
  /\bAIza[A-Za-z0-9_-]{30,}/, // Google
  /\bAKIA[A-Z0-9]{16}\b/, // AWS
  /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}/, // a JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i,
];

const envReference = (v: string): boolean => /^\$?\{?[A-Z][A-Z0-9_]*\}?$/.test(v.trim());

/** The first credential in `value` (where it was), or null. A key's value is judged, an empty one isn't one. */
export function credentialProblem(value: unknown, at = ""): string | null {
  if (typeof value === "string") return SECRET_SHAPES.some((re) => re.test(value)) ? at || "the value" : null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = credentialProblem(value[i], `${at}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const where = at ? `${at}.${k}` : k;
    if (CREDENTIAL_KEY.test(k) && typeof v === "string" && v.trim() && !envReference(v)) return where;
    const hit = credentialProblem(v, where);
    if (hit) return hit;
  }
  return null;
}

/** §design.copy-deck/create-mode: "A setting that is a credential". */
export const credentialRefusal = (where = "Sign in with `/login` in a terminal, or on Settings → Accounts for Claude."): string => `Create doesn't handle sign-ins or keys. ${where}`;
