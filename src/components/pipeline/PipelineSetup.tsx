import { createMemo, createSignal, For, Show } from "solid-js";
import type { CheckChip, Stage } from "../../lib/pipeline";
import { announce } from "../../lib/ui-state";
import { Icon } from "../ui";
import { Sheet, StageDetail } from "./PipelineParts";

/**
 * The Setup view (§app.merge-queue/explainer): the pipeline as a numbered flow of stages, the Checks stage with its
 * lanes (every branch, only when the changed files match, only when the merge thread adds it), each stage or check
 * selectable for its rule, its trigger and what happens when it fails. Wide: the detail stays beside the flow; folded:
 * it opens in a sheet.
 */
export function SetupFlow(props: { title: string; sub: string; stages: Stage[]; wide: boolean; legend?: boolean; problem?: string }) {
  const [sel, setSel] = createSignal<{ stage: string; check?: string }>({ stage: props.stages[0]?.id ?? "" });
  const [sheet, setSheet] = createSignal(false);
  const selected = createMemo(() => {
    const s = props.stages.find((x) => x.id === sel().stage) ?? props.stages[0];
    if (!s) return null;
    const n = props.stages.indexOf(s) + 1;
    if (sel().check) {
      const all = (s.lanes ?? []).flatMap((l) => l.checks);
      const c = all.find((x) => x.id === sel().check);
      if (c) return { eyebrow: `Check ${all.indexOf(c) + 1} of ${all.length} · inside ${s.name}`, stage: { name: c.label, rule: c.rule, facts: c.facts } };
    }
    return { eyebrow: `Stage ${n} of ${props.stages.length}`, stage: s };
  });
  const pick = (stage: string, check?: string) => {
    setSel({ stage, ...(check ? { check } : {}) });
    if (!props.wide) setSheet(true);
    const d = selected();
    if (d) announce(`${d.stage.name} selected.`);
  };
  return (
    <div class="pl-setup-grid">
      <div style={{ "min-width": "0" }}>
        <h2 class="pl-section-title">{props.title}</h2>
        <p class="pl-section-sub">{props.sub}</p>
        <Show when={props.legend}>
          <div class="pl-legend" aria-hidden="true">
            <span>
              <i class="pl-legend-node" />
              Stage
            </span>
            <span>
              <i class="pl-legend-cond" />
              Only when files match
            </span>
            <span>
              <b class="pl-legend-back">↩</b>
              Back to the branch’s chat
            </span>
          </div>
        </Show>
        <Show when={props.problem}>
          <p class="pl-factbox is-error">
            <b>The setup doesn’t parse.</b> {props.problem}
          </p>
        </Show>
        <ol class="pl-flow">
          <For each={props.stages}>
            {(s, i) => (
              <li class="pl-stage" classList={{ "is-cond": !!s.cond }} data-stage={s.id}>
                <span class="pl-stage-node" aria-hidden="true">
                  {i() + 1}
                </span>
                <div class="pl-stage-card" classList={{ "is-selected": sel().stage === s.id && !sel().check }}>
                  <button type="button" class="pl-stage-head" aria-pressed={sel().stage === s.id && !sel().check ? "true" : "false"} onClick={() => pick(s.id)}>
                    <span class="pl-stage-text">
                      <span class="pl-stage-name">{s.name}</span>
                      <span class="pl-stage-line">{s.line}</span>
                    </span>
                    <span class="pl-stage-end">
                      <Show when={s.back}>
                        <span class="pl-back" title="A failure here goes back to the branch’s chat">
                          ↩ back
                        </span>
                      </Show>
                      <Show when={s.end}>
                        <span class="pl-stage-dur">{s.end}</span>
                      </Show>
                      <Icon name="chevron-right" small />
                    </span>
                  </button>
                  <Show when={s.lanes?.length}>
                    <div class="pl-stage-checks">
                      <For each={s.lanes}>
                        {(l) => (
                          <div class="pl-lane">
                            <p class="pl-lane-label">{l.label}</p>
                            <div class="pl-lane-grid">
                              <For each={l.checks}>{(c) => <CheckButton c={c} selected={sel().stage === s.id && sel().check === c.id} onPick={() => pick(s.id, c.id)} />}</For>
                            </div>
                          </div>
                        )}
                      </For>
                      <Show when={s.note}>
                        <p class="pl-checks-note">{s.note}</p>
                      </Show>
                    </div>
                  </Show>
                  <Show when={s.warn}>
                    <p class="pl-stage-warn">{s.warn}</p>
                  </Show>
                </div>
              </li>
            )}
          </For>
        </ol>
      </div>
      <aside class="pl-aside" aria-label="Stage detail" aria-live="polite">
        <Show when={selected()}>{(d) => <StageDetail stage={d().stage} eyebrow={d().eyebrow} />}</Show>
      </aside>
      <Show when={sheet() && !props.wide && selected()}>
        {(d) => (
          <Sheet title={d().stage.name} sub={d().eyebrow} onClose={() => setSheet(false)}>
            <StageDetail stage={d().stage} eyebrow={d().eyebrow} bare />
          </Sheet>
        )}
      </Show>
    </div>
  );
}

function CheckButton(props: { c: CheckChip; selected: boolean; onPick(): void }) {
  return (
    <button type="button" class="pl-chk" classList={{ "is-cond": !!props.c.cond, "is-selected": props.selected }} aria-pressed={props.selected ? "true" : "false"} data-check={props.c.id} onClick={() => props.onPick()}>
      <span class="pl-chk-name">
        {props.c.label}
        <Show when={props.c.tag}>
          <span class="pl-tag">{props.c.tag}</span>
        </Show>
      </span>
      <span class="pl-chk-meta">{props.c.meta}</span>
    </button>
  );
}
