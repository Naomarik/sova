// What an entry's values may name (§app.mcp/environment, §app.mcp/secrets). `${NAME}` is the one form: a saved
// secret, and in a computer entry an environment variable of that name too. A project's file can name nothing but
// a saved secret. Nothing is ever run: `!command` is a literal string here, wherever it stands.
import type { McpEntry } from "./config";

const NAMED = /\$\{([^}]*)\}/g;
const PLAIN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Every string of an entry that takes a value. */
function valueStrings(e: McpEntry): string[] {
  const secret = e.oauth?.clientSecret;
  return [...(e.args ?? []), ...Object.values(e.env ?? {}), ...(e.url ? [e.url] : []), ...Object.values(e.headers ?? {}), ...(typeof secret === "string" ? [secret] : [])];
}

/** What the entry names: plain names, and the forms that are no name at all. */
export function namedValues(e: McpEntry): { names: string[]; bad: string[] } {
  const names = new Set<string>();
  const bad = new Set<string>();
  for (const text of valueStrings(e)) for (const m of text.matchAll(NAMED)) (PLAIN.test(m[1]!) ? names : bad).add(m[1]!);
  return { names: [...names], bad: [...bad] };
}

export const isSecretName = (name: string): boolean => PLAIN.test(name);

/** Each value with its names filled. A name `lookup` doesn't know stays and is `missing`. */
export function fillValues(e: McpEntry, lookup: (name: string) => string | undefined): { entry: McpEntry; missing: string[] } {
  const missing = new Set<string>();
  const fill = (text: string) =>
    text.replace(NAMED, (whole, name: string) => {
      const value = lookup(name);
      if (value === undefined) missing.add(name);
      return value ?? whole;
    });
  const map = (m: Record<string, string> | undefined) => (m ? Object.fromEntries(Object.entries(m).map(([k, v]) => [k, fill(v)])) : undefined);
  const entry: McpEntry = { ...e };
  if (e.args) entry.args = e.args.map(fill);
  if (e.env) entry.env = map(e.env)!;
  if (e.url) entry.url = fill(e.url);
  if (e.headers) entry.headers = map(e.headers)!;
  if (typeof e.oauth?.clientSecret === "string") entry.oauth = { ...e.oauth, clientSecret: fill(e.oauth.clientSecret) };
  return { entry, missing: [...missing] };
}

/** A package runner with no pinned version: "Runs the newest version each start." */
export function unpinned(e: McpEntry): boolean {
  const base = (e.command ?? "").split("/").pop() ?? "";
  const args = e.args ?? [];
  let rest: string[];
  if (base === "npx" || base === "bunx" || base === "uvx") rest = args;
  else if (base === "pnpm" && args[0] === "dlx") rest = args.slice(1);
  else if (base === "pipx" && args[0] === "run") rest = args.slice(1);
  else return false;
  const pkg = rest.find((a) => !a.startsWith("-"));
  if (!pkg) return false;
  const at = pkg.lastIndexOf("@");
  if (base === "uvx" && pkg.includes("==")) return false;
  return at <= 0 || !/^\d/.test(pkg.slice(at + 1));
}
