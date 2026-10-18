import { readFileSync } from "node:fs";
import { join } from "node:path";
import { periodAt, resolvePriceRef, type Aliases, type PriceTable } from "../shared/model-prices/prices";
import type { ModelPick } from "../shared/powers";
import type { PricedPick } from "../shared/project-assistant";
import { stateRoot } from "./state-root";

/**
 * A picked model's price for the Owner card (§app.project-assistant/models): USD per million input
 * and output tokens now, from this host's price table (`<stateRoot>/model-prices.json`, else the
 * checked-in seed) through the aliases (§app.project-costs/price-table). Unknown: no price.
 */

const PRICES_DIR = join(import.meta.dirname, "..", "shared", "model-prices");

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export function pricedPick(pick: ModelPick | null | undefined, now = Date.now()): PricedPick | null {
  if (!pick) return null;
  const table = readJson<PriceTable>(join(stateRoot(), "model-prices.json")) ?? readJson<PriceTable>(join(PRICES_DIR, "seed.json"));
  const aliases = readJson<Aliases>(join(PRICES_DIR, "aliases.json"));
  const slash = pick.model.indexOf("/");
  if (!table || !aliases || slash < 0) return { ...pick };
  try {
    const r = resolvePriceRef(table, aliases, { provider: pick.model.slice(0, slash), model: pick.model.slice(slash + 1) }, now);
    if ("free" in r) return { ...pick, price: { input: 0, output: 0 } };
    if (!("key" in r)) return { ...pick };
    const p = table.models[r.key] ? periodAt(table.models[r.key]!, now) : null;
    return p ? { ...pick, price: { input: p.rates.input, output: p.rates.output } } : { ...pick };
  } catch {
    return { ...pick };
  }
}
