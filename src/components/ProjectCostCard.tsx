import { createEffect, For, type JSX, on, Show } from "solid-js";
import { getProjectCost } from "../lib/api";
import { allModels, costNotes, emptyLine, ESTIMATE_TITLE, KIND_LABEL, kindRows, modelRows, starterLine, TOKEN_KINDS, topMeta, type CostTokens, type ModelCost, type ProjectCost, usd } from "../lib/costs";
import { orgSessionHref } from "../lib/orgs-route";
import { createPoll } from "../lib/poll";
import { tokens } from "../lib/project-overseer-view";

const COST_POLL_MS = 60_000;
const TOKEN_HEAD: Record<keyof CostTokens, string> = { input: "Input", output: "Output", cacheRead: "Cache read", cacheWrite: "Cache write" };

/** A figure in mono; `≈` and its title when part of it is an estimate. */
function Usd(props: { n: number; estimate?: boolean }) {
  return (
    <span class="text-num project-cost-usd" title={props.estimate ? ESTIMATE_TITLE : undefined}>
      {usd(props.n, props.estimate)}
    </span>
  );
}

/**
 * What the project's sessions would cost at each provider's API prices (§app.project-costs/card):
 * the total, who started what, by kind, by model and token kind, the most expensive sessions, and
 * what isn't priced or counted. Read on its own (it's heavier than the overseer's info): on open,
 * with Refresh Project (`tick`), and every 60 seconds while the tab shows.
 */
export function ProjectCostCard(props: { orgId: string; projectId: string; tick: number }) {
  const poll = createPoll(() => getProjectCost(props.orgId, props.projectId), COST_POLL_MS);
  createEffect(on(() => props.tick, () => poll.refetch(), { defer: true }));
  return (
    <section class="card orgs-section project-cost" aria-labelledby="project-cost">
      <h2 class="orgs-h2" id="project-cost">
        Cost
      </h2>
      <Show
        when={poll.data()}
        fallback={
          <p class="orgs-line project-muted" role="status">
            {poll.error() ? `Couldn't count this project's cost. ${poll.error()}` : "Counting…"}
          </p>
        }
      >
        {(c) => <CostBody cost={c()} orgId={props.orgId} />}
      </Show>
    </section>
  );
}

function CostBody(props: { cost: ProjectCost; orgId: string }) {
  const c = () => props.cost;
  const kinds = () => kindRows(c().byKind);
  const models = () => modelRows(c().byModel);
  const spent = () => c().totalUsd > 0 || models().length > 0;
  return (
    <Show when={spent()} fallback={<p class="orgs-line">{emptyLine(c().sessions)}</p>}>
      <div class="project-cost-head">
        <p class="project-cost-total">
          <Usd n={c().totalUsd} estimate={c().estimate} /> <span class="project-muted">at API prices</span>
        </p>
        <p class="orgs-line project-muted">What these sessions would cost at each provider's API prices. Your subscriptions bill differently.</p>
      </div>
      <Show when={starterLine(c().byStarter)}>{(line) => <p class="orgs-line project-cost-starters">{line()}</p>}</Show>
      <Show when={kinds().length}>
        <div class="md md-table-wrap project-cost-wrap">
          <table class="project-cost-table project-cost-kinds">
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
                      <Usd n={r.usd} estimate={r.estimate} />
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
      <Show when={models().length}>
        <div class="md md-table-wrap project-cost-wrap">
          <table class="project-cost-table project-cost-models">
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
                    <th scope="row" class="text-mono" title={r.name && r.name !== r.model ? r.model : undefined}>
                      {r.name ?? r.model}
                    </th>
                    <ModelCells row={r} />
                  </tr>
                )}
              </For>
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">All models</th>
                <ModelCells row={allModels(models())} />
              </tr>
            </tfoot>
          </table>
        </div>
      </Show>
      <Show when={c().top.length}>
        <h3 class="orgs-h3">Most expensive sessions</h3>
        <ul class="list project-cost-top">
          <For each={c().top}>
            {(s) => (
              <li class="list-row project-cost-top-row">
                <span class="list-main">
                  <span class="list-title">
                    <Show when={s.path} fallback={<>{s.title} <span class="project-muted">(not on this host)</span></>}>
                      {(p) => <a href={orgSessionHref(props.orgId, p())}>{s.title}</a>}
                    </Show>
                  </span>
                  <span class="list-meta">{topMeta(s.kind, s.by)}</span>
                </span>
                <Usd n={s.usd} estimate={s.estimate} />
              </li>
            )}
          </For>
        </ul>
      </Show>
      <ul class="project-cost-notes">
        <For each={costNotes(c())}>
          {(n) => (
            <li class="orgs-line project-muted" title={n.title}>
              {n.text}
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}

/** A model row's cells: each token kind's dollars over its count (muted), then the row's cost. Local and unpriced models say so instead of a figure. */
function ModelCells(props: { row: Pick<ModelCost, "tokens" | "usd" | "totalUsd" | "estimate" | "local" | "unpriced"> }): JSX.Element {
  const r = () => props.row;
  const money = (n: number, estimate?: boolean) =>
    r().unpriced !== undefined ? (
      <span class="project-muted" title={r().unpriced || undefined}>
        unpriced
      </span>
    ) : r().local ? (
      <span class="project-muted">local</span>
    ) : (
      <Usd n={n} estimate={estimate} />
    );
  return (
    <>
      <For each={TOKEN_KINDS}>
        {(k) => (
          <td align="right" data-label={TOKEN_HEAD[k]}>
            <span class="project-cost-cell">
              {money(r().usd[k])}
              <span class="text-mono text-num project-muted project-cost-tokens">{tokens(r().tokens[k])}</span>
            </span>
          </td>
        )}
      </For>
      <td align="right" data-label="Cost">
        {money(r().totalUsd, r().estimate)}
      </td>
    </>
  );
}
