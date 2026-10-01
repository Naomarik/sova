import type { ModelInfo } from "../../shared/protocol";

/**
 * The model picker's rows: which groups and rows each step
 * shows, in keyboard order. Pure, so the step logic is testable without a DOM; the picker in
 * src/components/ModelMenu.tsx renders exactly what this returns.
 */

/** Which step the picker is on: every provider, or one provider's models. */
export type PickerStep = { kind: "providers" } | { kind: "provider"; provider: string };

export type PickerItem =
  | { kind: "model"; key: string; model: ModelInfo; /** Show the provider caption (the group doesn't name it). */ caption: boolean }
  | { kind: "provider"; key: string; provider: string; count: number; /** The current model's provider. */ current: boolean };

export interface PickerGroup {
  key: string;
  /** The group label; null for a step-2 list, whose head names the provider. */
  label: string | null;
  items: PickerItem[];
}

export const modelKey = (ref: string) => `m:${ref}`;
export const providerKey = (provider: string) => `p:${provider}`;

/** Every query token must appear in provider/id, case-insensitively. */
export function matchModels(models: ModelInfo[], query: string): ModelInfo[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  return models.filter((m) => tokens.every((t) => m.ref.toLowerCase().includes(t)));
}

const byProviderThenId = (a: ModelInfo, b: ModelInfo) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id);

/** The providers that have at least one of these models, sorted by name, with their counts. */
export function providersOf(models: ModelInfo[]): { provider: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const m of models) counts.set(m.provider, (counts.get(m.provider) ?? 0) + 1);
  return [...counts].map(([provider, count]) => ({ provider, count })).sort((a, b) => a.provider.localeCompare(b.provider));
}

/** The provider the picker opens on when there's only one to choose from, else null (open on Providers). */
export function onlyProvider(models: ModelInfo[]): string | null {
  const providers = providersOf(models);
  return providers.length === 1 ? providers[0]!.provider : null;
}

/**
 * The groups a step shows for `models` (already the usable ones) and `query`.
 * - Providers, no query: Favorites (model rows with a provider caption), then Providers.
 * - Providers, a query: every match, grouped under its provider's name.
 * - One provider: its models (filtered by the query), sorted by id, under no label.
 */
export function pickerGroups(models: ModelInfo[], step: PickerStep, query: string, currentRef: string | null): PickerGroup[] {
  const model = (m: ModelInfo, caption: boolean): PickerItem => ({ kind: "model", key: modelKey(m.ref), model: m, caption });
  if (step.kind === "provider") {
    const items = matchModels(
      models.filter((m) => m.provider === step.provider),
      query,
    )
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((m) => model(m, false));
    return items.length ? [{ key: `provider-${step.provider}`, label: null, items }] : [];
  }
  if (query.trim()) {
    const groups: PickerGroup[] = [];
    for (const m of matchModels(models, query).sort(byProviderThenId)) {
      const last = groups[groups.length - 1];
      if (last?.label === m.provider) last.items.push(model(m, false));
      else groups.push({ key: `provider-${m.provider}`, label: m.provider, items: [model(m, false)] });
    }
    return groups;
  }
  const currentProvider = currentRef ? (models.find((m) => m.ref === currentRef)?.provider ?? null) : null;
  const favorites = models.filter((m) => m.favorite).sort((a, b) => a.ref.localeCompare(b.ref));
  const providers = providersOf(models);
  const out: PickerGroup[] = [];
  if (favorites.length) out.push({ key: "fav", label: "Favorites", items: favorites.map((m) => model(m, true)) });
  if (providers.length)
    out.push({
      key: "providers",
      label: "Providers",
      items: providers.map(({ provider, count }) => ({ kind: "provider", key: providerKey(provider), provider, count, current: provider === currentProvider })),
    });
  return out;
}

/** The keyboard position a step starts on: the current provider (Providers) or model (one provider), else the first row. */
export function initialActive(groups: PickerGroup[], step: PickerStep, currentRef: string | null): string | null {
  const items = groups.flatMap((g) => g.items);
  const wanted =
    step.kind === "providers"
      ? items.find((i) => i.kind === "provider" && i.current)
      : items.find((i) => i.kind === "model" && i.model.ref === currentRef);
  return (wanted ?? items[0])?.key ?? null;
}

/** "20 models" · "1 model". */
export const modelCount = (n: number) => `${n} ${n === 1 ? "model" : "models"}`;
