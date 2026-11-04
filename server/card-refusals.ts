/**
 * Credentials never pass through a Create card (§chat.create-mode/settings-cards). `credentialProblem` looks
 * through whatever a card would carry: a key named like a credential holding a value, and any string shaped like
 * one. pi resolves `$NAME` and `${NAME}` from the environment, so those are references, not secrets. A bare all-capitals
 * word passes too: pi takes it literally, which is what a local server's dummy value is, and no real key looks like
 * it. pi's `!command` form does not pass, because it runs a command to fetch one.
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

const envReference = (v: string): boolean => /^(\$[A-Za-z_][A-Za-z0-9_]*|\$\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Z][A-Z0-9_]*)$/.test(v.trim());

/** What `value` adds or changes over `before`, the rest left out: a whole-file value holds much it isn't changing. */
export function changedPart(value: unknown, before: unknown): unknown {
  if (JSON.stringify(value) === JSON.stringify(before)) return undefined;
  if (Array.isArray(value)) {
    const was = Array.isArray(before) ? before : [];
    return value.filter((x) => !was.some((y) => JSON.stringify(x) === JSON.stringify(y))).map((x, i) => changedPart(x, was[i]));
  }
  if (!value || typeof value !== "object" || !before || typeof before !== "object" || Array.isArray(before)) return value;
  const was = before as Record<string, unknown>;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => (k in was && JSON.stringify(v) === JSON.stringify(was[k]) ? [] : [[k, changedPart(v, was[k])]])));
}

/**
 * A card's check: what it changes is judged by names and shapes. What it only keeps is judged by shape alone: a
 * local server's dummy `apiKey: "ollama"` already in the file is no new credential, a real-looking key still is.
 */
export const cardCredential = (value: unknown, before: unknown): string | null => credentialProblem(changedPart(value, before)) ?? (SECRET_SHAPES.some((re) => re.test(JSON.stringify(value) ?? "")) ? "the value" : null);

/** A command-line argument that hands over a credential: `--token=…`, or `--token` with its value in the next one. */
export const credentialArg = (arg: string): boolean => arg.startsWith("-") && CREDENTIAL_KEY.test(arg.split("=")[0]!);

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

/**
 * §design.copy-deck/create-mode: "A setting that is a credential". The scan goes by names and shapes, so it can take
 * a plain value for a key: `place` says where the person can make the change themselves, so a wrong refusal is no
 * dead end.
 */
export const credentialRefusal = (place: string, where = "Sign in with `/login` in a terminal, or on Settings → Accounts for Claude."): string =>
  `Create doesn't handle sign-ins or keys. ${where} If this isn't a key, name the place for the person, who can make the change themselves: ${place}.`;
