import type { ModelInfo } from "../../shared/protocol";

/** One provider and the models it serves, as Settings → Models draws them. */
export interface ProviderGroup {
  provider: string;
  models: ModelInfo[];
  /** A provider with no models of its own: the Claude Code backend, or a name the policy holds
      that this machine has no credentials for. Its switches still apply to the whole group. */
  note?: string;
}

/** The two policy lists that can name a provider this machine has no models for. */
export interface PolicyProviders {
  disabledProviders: string[];
  subagentDisabledProviders: string[];
}

/**
 * Settings → Models' provider groups, with stable identity. The list renders them with `<For>`,
 * which keys on object identity: a fresh group object or `models` array disposes every row under
 * it, and while the old rows are gone the panel is short enough that the browser may reset its
 * scroll (a toggle used to jump the panel to the top). So a policy change must never rebuild a
 * group whose models did not change.
 *
 * The caches below are what make identity stable. `byModels` keeps one group object per provider
 * name and reuses it while that provider's model list — same models, same order — is unchanged;
 * a provider whose list changed gets a new group and a new array, so nothing stale survives. The
 * policy only adds the "No models on this machine" rows, cached per name in `withPolicy`.
 */
export function providerGrouper(lead: ProviderGroup) {
  let modelGroups = new Map<string, ProviderGroup>();
  let orphans = new Map<string, ProviderGroup>();

  /** The lead group, then one group per provider, name-sorted — the model picker's order. */
  const byModels = (models: readonly ModelInfo[]): ProviderGroup[] => {
    const byProvider = new Map<string, ModelInfo[]>();
    for (const m of models) {
      const list = byProvider.get(m.provider.toLowerCase());
      if (list) list.push(m);
      else byProvider.set(m.provider.toLowerCase(), [m]);
    }
    const next = new Map<string, ProviderGroup>();
    const rows = [...byProvider.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([provider, list]) => {
        list.sort((a, b) => a.id.localeCompare(b.id));
        const cached = modelGroups.get(provider);
        const group =
          cached && cached.models.length === list.length && cached.models.every((m, i) => m === list[i])
            ? cached
            : { provider, models: list };
        next.set(provider, group);
        return group;
      });
    modelGroups = next; // a provider that left the list is forgotten, not kept stale
    return [lead, ...rows];
  };

  /** `base` plus a row for each provider the policy names that has no group of its own. */
  const withPolicy = (base: ProviderGroup[], policy: PolicyProviders | null): ProviderGroup[] => {
    if (!policy) return base;
    const named = new Set(
      [...policy.disabledProviders, ...policy.subagentDisabledProviders].map((x) => x.toLowerCase()),
    );
    const next = new Map<string, ProviderGroup>();
    const rows = [...base];
    for (const provider of [...named].sort())
      if (!base.some((row) => row.provider === provider)) {
        const group = orphans.get(provider) ?? { provider, models: [], note: "No models on this machine" };
        next.set(provider, group);
        rows.push(group);
      }
    orphans = next;
    return rows;
  };

  return { byModels, withPolicy };
}
