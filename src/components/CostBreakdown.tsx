import { createUniqueId, For, type JSX, Show } from "solid-js";
import type { UsagePricing, UsageSpend } from "../../shared/usage/wire";
import { breakdownKind, cacheWriteSplit, type CostPart, costParts, shareWords } from "../lib/cost-history";
import { usd } from "../lib/costs";
import { tokens as tokenWords } from "../lib/project-overseer-view";
import "../cost-breakdown.css";
import { Icon } from "./ui";

/** A row the breakdown can split: its spend, and how it was priced. */
export type BreakdownRow = Pick<UsageSpend, "usd" | "usdBy" | "tokens" | "unpricedTokens"> & Pick<UsagePricing, "status" | "why">;

/** The open state of a table's model rows, by row key: any number open, all closed at first. */
export const toggleKey = (open: ReadonlySet<string>, key: string): ReadonlySet<string> => {
  const next = new Set(open);
  if (!next.delete(key)) next.add(key);
  return next;
};

/** Keep only the keys still listed, so a model that leaves the table doesn't come back open. */
export const keepListed = (open: ReadonlySet<string>, keys: readonly string[]): ReadonlySet<string> => {
  const listed = new Set(keys);
  const next = new Set([...open].filter((k) => listed.has(k)));
  return next.size === open.size ? open : next;
};

/**
 * A model row's open control: the chevron and the model's name (and its second line), one button,
 * so Enter or Space on the name opens and closes it. The row itself takes the click (see `rowClick`).
 */
export function OpenName(props: { open: boolean; controls: string; name: string; children: JSX.Element }) {
  return (
    <button type="button" class="cost-open" aria-expanded={props.open ? "true" : "false"} aria-controls={props.controls}>
      <Icon name="chevron-right" small />
      <span class="cost-open-name">{props.children}</span>
      <span class="visually-hidden">{props.open ? `, hide where ${props.name}'s cost went` : `, show where ${props.name}'s cost went`}</span>
    </button>
  );
}

/** A model row's click handler: a click anywhere on the row toggles it, but not one that ends a
    text selection (someone copying a figure). */
export const rowClick = (toggle: () => void) => () => {
  if (typeof window !== "undefined" && window.getSelection?.()?.toString()) return;
  toggle();
};

/** A fresh id for a row's detail, unique on the page whatever characters its model id holds. */
export const detailId = () => `cost-detail-${createUniqueId()}`;

const SWATCH: Record<CostPart["part"], string> = {
  cacheWrite: "cost-part-write",
  cacheRead: "cost-part-read",
  output: "cost-part-output",
  input: "cost-part-input",
};

/**
 * "Where {model}'s cost went": one bar in four parts, then the legend in its fixed order (Cache
 * writes, Cache reads, Output, Input), each part its dollars, its share of the row's cost and its
 * tokens. An unpriced or free model shows only the token split, and says why.
 */
export function CostBreakdown(props: { row: BreakdownRow; name: string; fmt?: (n: number) => string }) {
  const fmt = (n: number) => (props.fmt ?? tokenWords)(n);
  const kind = () => breakdownKind(props.row);
  const parts = () => costParts(props.row);
  const priced = () => kind() === "priced" || kind() === "partly";
  const split = () => cacheWriteSplit(props.row);
  const headId = `cost-breakdown-${createUniqueId()}`;
  const writeTitle = () => {
    const s = split();
    return `1-hour writes: ${usd(s.hour.usd)} · ${fmt(s.hour.tokens)} tokens\n5-minute writes: ${usd(s.fiveMin.usd)} · ${fmt(s.fiveMin.tokens)} tokens`;
  };
  const writeTokensTitle = () => {
    const s = split();
    return `1-hour writes: ${fmt(s.hour.tokens)} tokens\n5-minute writes: ${fmt(s.fiveMin.tokens)} tokens`;
  };
  const barLabel = () =>
    parts()
      .map((p) => `${p.label} ${shareWords(p.share)}`)
      .join(", ");
  return (
    <div class="cost-breakdown" role="group" aria-labelledby={headId}>
      <h3 class="cost-breakdown-h" id={headId}>
        Where <span class="text-mono">{props.name}</span>'s cost went
      </h3>
      <Show when={priced()}>
        <div class="cost-split-bar" role="img" aria-label={`${props.name}'s cost: ${barLabel()}`}>
          <For each={parts().filter((p) => (p.share ?? 0) > 0)}>
            {(p) => <span class={`cost-split-seg ${SWATCH[p.part]}`} style={{ "flex-grow": String(p.share ?? 0) }} title={`${p.label}: ${usd(p.usd)}, ${shareWords(p.share)}`} />}
          </For>
        </div>
      </Show>
      <Show when={kind() === "unpriced"}>
        <p class="cost-note">No price on record, so no cost split.</p>
      </Show>
      <Show when={kind() === "free"}>
        <p class="cost-note">{props.row.why === "local" ? "It runs on this device, so it costs nothing." : "It costs nothing, so there is no cost split."}</p>
      </Show>
      <ul class="cost-split-legend">
        <For each={parts()}>
          {(p) => (
            <li class="cost-split-item" title={p.part === "cacheWrite" ? (priced() ? writeTitle() : writeTokensTitle()) : undefined}>
              <span class={`cost-split-swatch ${SWATCH[p.part]}`} aria-hidden="true" />
              <span class="cost-split-label">{p.label}</span>
              <Show when={priced()}>
                <span class="cost-figure">{usd(p.usd)}</span>
                <span class="cost-figure cost-split-share">{shareWords(p.share)}</span>
              </Show>
              <span class="cost-figure cost-split-tokens">{fmt(p.tokens)} tok</span>
              <Show when={p.part === "cacheWrite" && p.tokens > 0}>
                <span class="visually-hidden">. {priced() ? writeTitle() : writeTokensTitle()}</span>
              </Show>
            </li>
          )}
        </For>
      </ul>
      <Show when={kind() === "partly"}>
        <p class="cost-note">
          {fmt(props.row.unpricedTokens)} {props.row.unpricedTokens === 1 ? "token" : "tokens"} had no price: the dollars split the priced calls, the token counts cover every call.
        </p>
      </Show>
    </div>
  );
}
