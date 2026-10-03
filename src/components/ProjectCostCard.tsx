import { createEffect, For, type JSX, on, Show } from "solid-js";
import type { CostModelRow, CostTokens, ProjectCost } from "../../shared/costs";
import { getProjectCost } from "../lib/api";
import { allModels, costNotes, emptyLine, ESTIMATE_TITLE, hasEstimate, KIND_LABEL, kindRows, moneyWord, modelRows, starterParts, TOKEN_KINDS, topMeta, usd } from "../lib/costs";
import { projectSessionHref } from "../lib/projects-route";
import { createPoll, type Poll } from "../lib/poll";
import { tokens } from "../lib/project-overseer-view";

const COST_POLL_MS = 60_000;
const TOKEN_HEAD: Record<(typeof TOKEN_KINDS)[number], string> = { input: "Input", output: "Output", cacheRead: "Cache read", cacheWrite: "Cache write" };

/**
 * The project's cost, read on its own (it's heavier than the overseer's info): on open, with
 * Refresh Project (`tick`), and every 60 seconds while the tab shows. The page reads it once for
 * its summary chip and its Cost tab.
 */
export function createProjectCost(props: { projectId: string; tick(): number }): Poll<ProjectCost> {
  const poll = createPoll(() => getProjectCost(props.projectId), COST_POLL_MS);
  createEffect(on(props.tick, () => poll.refetch(), { defer: true }));
  return poll;
}

/** The total as the card's headline writes it (`$27.21`, `≈$4.10`), for the summary chip. */
export const costFigure = (c: ProjectCost): string => usd(c.totalUsd, hasEstimate(c));

/**
 * What the project's sessions would cost at each provider's API prices (§app.project-costs/card):
 * the total, who started what, the most expensive sessions, by kind and by model and token kind
 * behind Breakdown, and what isn't priced or counted.
 */
export function ProjectCostCard(props: { projectId: string; poll: Poll<ProjectCost> }) {
  const poll = props.poll;
  return (
    <section class="card orgs-section" aria-labelledby="project-cost">
      <h2 class="orgs-h2" id="project-cost">
        Cost
      </h2>
      <Show when={poll.data()} fallback={<p class="cost-lede">{poll.error() ? `Couldn't count this project's cost. ${poll.error()}` : "Counting…"}</p>}>
        {(c) => <CostBody cost={c()} projectId={props.projectId} />}
      </Show>
    </section>
  );
}

function CostBody(props: { cost: ProjectCost; projectId: string }) {
  const c = () => props.cost;
  const kinds = () => kindRows(c().byKind);
  const models = () => modelRows(c().byModel);
  const spent = () => c().totalUsd > 0 || models().length > 0;
  const estimate = () => hasEstimate(c());
  return (
    <Show when={spent()} fallback={<p class="orgs-line">{emptyLine(c().sessions)}</p>}>
      <div>
        <p class="cost-headline">
          <span class="cost-figure" title={estimate() ? ESTIMATE_TITLE : undefined}>
            {usd(c().totalUsd, estimate())}
          </span>
          <span class="cost-headline-unit">at API prices</span>
        </p>
        <p class="cost-lede">What these sessions would cost at each provider's API prices. Your subscriptions bill differently.</p>
      </div>
      <Show when={starterParts(c().byStarter).length}>
        <p class="cost-lede">
          <For each={starterParts(c().byStarter)}>
            {(p, i) => (
              <>
                {i() > 0 ? " · " : ""}
                {p.words} <span class="cost-figure">{p.usd}</span>
              </>
            )}
          </For>
        </p>
      </Show>
      <Show when={c().top.length}>
        <h3 class="orgs-h3">Most expensive sessions</h3>
        <ol class="cost-sessions">
          <For each={c().top}>
            {(s) => (
              <li class="cost-session">
                <span class="cost-session-main">
                  <Show when={s.path} fallback={<>{s.title}{s.countedAt ? " (not on this host)" : ""}</>}>
                    {(p) => <a href={projectSessionHref(props.projectId, p())}>{s.title}</a>}
                  </Show>
                  <span class="cost-session-meta">{topMeta(s.kind, s.by)}</span>
                </span>
                <span class="cost-figure">{usd(s.usd)}</span>
              </li>
            )}
          </For>
        </ol>
      </Show>
      <Show when={kinds().length || models().length}>
        <details class="orgs-history cost-breakdown">
          <summary>Breakdown by kind and model</summary>
          <Show when={kinds().length}>
            <div class="md md-table-wrap cost-table-wrap">
              <table class="cost-table">
                <caption class="visually-hidden">Cost by kind</caption>
                <thead>
                  <tr>
                    <th scope="col">Kind</th>
                    <th scope="col" align="right">
                      Cost
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <For each={kinds()}>
                    {(r) => (
                      <tr>
                        <th scope="row">{KIND_LABEL[r.kind]}</th>
                        <td align="right" data-label="Cost">
                          <span class="cost-figure">{usd(r.usd)}</span>
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>
          <Show when={models().length}>
            <div class="md md-table-wrap cost-table-wrap">
              <table class="cost-table cost-table-stack">
                <caption class="visually-hidden">Cost by model and token kind</caption>
                <thead>
                  <tr>
                    <th scope="col">Model</th>
                    <For each={TOKEN_KINDS}>
                      {(k) => (
                        <th scope="col" align="right">
                          {TOKEN_HEAD[k]}
                        </th>
                      )}
                    </For>
                    <th scope="col" align="right">
                      Cost
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <For each={models()}>
                    {(r) => (
                      <tr>
                        <th scope="row" class={r.name ? undefined : "text-mono"} title={r.name ? r.model : undefined}>
                          {r.name ?? r.model}
                        </th>
                        <ModelCells row={r} />
                      </tr>
                    )}
                  </For>
                </tbody>
                {/* One model: its own row already says it all. */}
                <Show when={models().length > 1}>
                  <tfoot>
                    <tr>
                      <th scope="row">All models</th>
                      <ModelCells row={{ ...allModels(models()), status: "priced" }} />
                    </tr>
                  </tfoot>
                </Show>
              </table>
            </div>
          </Show>
        </details>
      </Show>
      <ul class="cost-notes">
        <For each={costNotes(c())}>
          {(n) => (
            <li class="cost-note" title={n.title}>
              {n.text}
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}

/** A model row's cells: each token kind's dollars over its count (muted), then the row's cost. Local and unpriced models say so instead of a figure. */
function ModelCells(props: { row: Pick<CostModelRow, "tokens" | "usdBy" | "usd" | "status" | "why"> }): JSX.Element {
  const word = () => moneyWord(props.row);
  const money = (n: number) => (word() === "usd" ? <span class="cost-figure">{usd(n)}</span> : <span class="cost-unpriced" title={word() === "unpriced" ? props.row.why : undefined}>{word()}</span>);
  const cell = (k: keyof CostTokens) => props.row.tokens[k];
  return (
    <>
      <For each={TOKEN_KINDS}>
        {(k) => (
          <td align="right" data-label={TOKEN_HEAD[k]}>
            {money(props.row.usdBy[k])}
            <span class="cost-tokens">{tokens(cell(k))}</span>
          </td>
        )}
      </For>
      <td align="right" data-label="Cost">
        {money(props.row.usd)}
      </td>
    </>
  );
}
