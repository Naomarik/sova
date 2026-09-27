import { createResource, For, type JSX, Show } from "solid-js";
import { getProjectCost } from "../lib/api";
import { formatTokens } from "../lib/context";
import { byCost, costNotes, KIND_LABEL, STARTER_LABEL, totalRow, TOKEN_KINDS, type CostRow, type ProjectCost, usd } from "../lib/costs";

const TOKEN_HEAD = { input: "Input", output: "Output", cacheRead: "Cache read", cacheWrite: "Cache write" } as const;

/**
 * What the project's sessions would cost at each provider's API prices (§app/project-costs/card):
 * the total, then by kind, by who started it, and by model and token kind, with what isn't priced
 * or counted said plainly. Read on its own, apart from the overseer's info: it's heavier.
 */
export function ProjectCostCard(props: { orgId: string; projectId: string; tick: number }) {
  const [cost] = createResource(
    () => ({ o: props.orgId, p: props.projectId, t: props.tick }),
    (k) => getProjectCost(k.o, k.p),
  );
  return (
    <section class="card orgs-section project-cost" aria-labelledby="project-cost">
      <h2 class="orgs-h2" id="project-cost">
        Cost
      </h2>
      <Show when={cost()} fallback={<Show when={cost.error} fallback={<p class="orgs-line project-muted">Counting…</p>}>{<p class="orgs-line">Couldn't count this project's cost. Refresh to try again.</p>}</Show>}>
        {(c) => <CostBody cost={c()} />}
      </Show>
    </section>
  );
}

function CostBody(props: { cost: ProjectCost }) {
  const c = () => props.cost;
  const kinds = () => byCost(c().byKind, (r) => r.kind);
  const starters = () => byCost(c().byStarter, (r) => r.by);
  const models = () => byCost(c().byModel, (r) => r.model);
  const spent = () => c().totalUsd > 0 || kinds().length > 0;
  return (
    <Show when={spent()} fallback={<p class="orgs-line">{c().sessions} {c().sessions === 1 ? "session" : "sessions"} in this project. Nothing spent yet.</p>}>
      <p class="project-cost-total">
        <span class="text-num project-cost-usd">{usd(c().totalUsd)}</span> <span class="project-muted">at API prices</span>
      </p>
      <p class="orgs-line project-muted">What these sessions would cost at each provider's API prices. Your subscriptions bill differently.</p>
      <CostTable caption="By kind" head="Kind" rows={kinds().map((r) => ({ label: KIND_LABEL[r.kind], row: r }))} total={totalRow(kinds())} />
      <Show when={starters().length > 1}>
        <CostTable caption="By who started it" head="Started by" rows={starters().map((r) => ({ label: STARTER_LABEL[r.by], row: r }))} />
      </Show>
      <CostTable caption="By model" head="Model" mono rows={models().map((r) => ({ label: r.name ?? r.model, title: r.model, row: r }))} total={totalRow(models())} />
      <ul class="project-cost-notes">
        <For each={costNotes(c())}>{(line) => <li class="orgs-line project-muted">{line}</li>}</For>
      </ul>
    </Show>
  );
}

/** One breakdown: a row per group, the four token kinds, then its dollars; stacked in a narrow pane. */
function CostTable(props: { caption: string; head: string; mono?: boolean; rows: { label: string; title?: string; row: CostRow }[]; total?: CostRow }) {
  const cells = (r: CostRow): JSX.Element => (
    <>
      <For each={TOKEN_KINDS}>
        {(k) => (
          <td align="right" class="text-mono text-num" data-label={TOKEN_HEAD[k]}>
            {formatTokens(r.tokens[k])}
          </td>
        )}
      </For>
      <td align="right" class="text-mono text-num project-cost-cell-usd" data-label="Cost">
        {usd(r.usd)}
      </td>
    </>
  );
  return (
    <div class="md md-table-wrap project-cost-wrap">
      <table class="project-cost-table">
        <caption class="project-cost-caption">{props.caption}</caption>
        <thead>
          <tr>
            <th scope="col">{props.head}</th>
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
          <For each={props.rows}>
            {(r) => (
              <tr>
                <th scope="row" class={props.mono ? "text-mono project-cost-label" : "project-cost-label"} title={r.title}>
                  {r.label}
                </th>
                {cells(r.row)}
              </tr>
            )}
          </For>
        </tbody>
        <Show when={props.total && props.rows.length > 1}>
          <tfoot>
            <tr>
              <th scope="row" class="project-cost-label">
                Total
              </th>
              {cells(props.total!)}
            </tr>
          </tfoot>
        </Show>
      </table>
    </div>
  );
}
