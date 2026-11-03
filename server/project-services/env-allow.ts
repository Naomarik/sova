/**
 * What a project's processes (services, hooks, setup, a merge run's checks) inherit from the server: nothing secret,
 * nothing that points at a chat. The XDG homes and mise's own settings come along, so a copy's mise (its tools, its
 * trust) is the server's; never a mise variable that reads as a credential (MISE_GITHUB_TOKEN).
 */
export const ENV_ALLOW = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TZ", "XDG_RUNTIME_DIR", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "SHELL", "TMPDIR"];

const CREDENTIAL = /TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL/i;

/** Whether `name` is inherited (with `extra` names a caller adds). */
export const inherits = (name: string, extra: readonly string[] = []): boolean => ENV_ALLOW.includes(name) || extra.includes(name) || (name.startsWith("MISE_") && !CREDENTIAL.test(name));

/** The inherited part of `env`, LANG defaulting to C.UTF-8. */
export function inheritedEnv(env: NodeJS.ProcessEnv = process.env, extra: readonly string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && inherits(k, extra)) out[k] = v;
  out.LANG ??= "C.UTF-8";
  return out;
}
