// The Causal View: one event's local chain as the server traced it, drawn as one ordered list in four
// sections: Came from (its causes, on a solid rail), this event, Led to (its consequences, solid), and
// Related · not causes (a dashed rail). Each edge's words sit between the cards they join, from the
// card's side, so causes and relations stay apart by section and by words, never by line style alone.
// Where no trigger was recorded the list says so in words, with no line. No canvas: it never scrolls
// sideways. The list is keyboard navigable with the arrow keys, Home and End.
import { createMemo, For, Show } from "solid-js";
import { isUnknown, type EventSummary } from "../../shared/org-history";
import { getHistoryChain } from "../lib/api";
import type { HistoryFilters, HistoryView } from "../lib/org-history-route";
import { actorWord, outcomeChip, OUTSIDE_FILTER, projectWords, rowClock, TRIGGER_NOT_RECORDED } from "../lib/org-history-words";
import { boundLine, chainSections, type ChainItem } from "../lib/org-history-chain";
import { createHistoryChain } from "../lib/org-history-source";
import { outsideFilter } from "./OrgHistory";
import { Banner, Chip } from "./ui";

type Href = (over: Partial<HistoryView>) => string;

export function OrgHistoryChain(props: { orgId: string; root: string; filters: HistoryFilters; hrefWith: Href }) {
  const { chain, error, busy, read } = createHistoryChain({
    root: () => props.root,
    projects: () => props.filters.projects,
    fetch: (root, projects, cursor) => getHistoryChain(props.orgId, root, { projects, ...(cursor ? { cursor } : {}) }),
  });
  const sections = createMemo(() => (chain() ? chainSections(chain()!) : null));
  const byId = createMemo(() => new Map((chain()?.nodes ?? []).map((n) => [n.id, n])));
  const expand = (side: "before" | "after") => {
    const o = chain()?.omitted;
    if (!o || !chain()!.cursor) return null;
    // One cursor: the earlier events first, then the later ones.
    if (side === "before" && o.before) return `Expand ${o.before} Earlier ${o.before === 1 ? "Event" : "Events"}`;
    if (side === "after" && !o.before && o.after) return `Expand ${o.after} Later ${o.after === 1 ? "Event" : "Events"}`;
    return null;
  };
  const ExpandButton = (p: { side: "before" | "after" }) => (
    <Show when={expand(p.side)}>
      {(w) => (
        <div class="button-row">
          <button type="button" class="button" aria-busy={busy() ? "true" : undefined} onClick={() => read(chain()!.cursor!)}>
            {w()}
          </button>
        </div>
      )}
    </Show>
  );
  let ladder: HTMLDivElement | undefined;
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    const links = [...(ladder?.querySelectorAll<HTMLAnchorElement>("a[data-chain-link]") ?? [])].filter((a) => a.offsetParent !== null);
    const i = links.indexOf(document.activeElement as HTMLAnchorElement);
    if (i < 0) return;
    const next = e.key === "Home" ? 0 : e.key === "End" ? links.length - 1 : e.key === "ArrowDown" ? Math.min(links.length - 1, i + 1) : Math.max(0, i - 1);
    e.preventDefault();
    links[next]?.focus();
  };
  const root = () => byId().get(props.root);
  return (
    <section class="orghist-chain" aria-labelledby="orghist-chain-title">
      <div class="orghist-chain-head">
        <h3 class="orgs-h3" id="orghist-chain-title">
          Causal View
        </h3>
        <Show when={chain()}>{(c) => <p class="orghist-caption">{boundLine(c().nodes.length, c().omitted)}</p>}</Show>
      </div>
      <Show when={error()}>{(e) => <Banner tone="error" title="Couldn't read the chain." body={e()} action={<button type="button" class="button button-sm" onClick={() => read()}>Retry</button>} />}</Show>
      <Show when={sections()} fallback={<Show when={!error()}><div class="skeleton skeleton-row" aria-label="Reading the chain" /></Show>}>
        {(s) => (
          <div class="orghist-ladder" ref={ladder} onKeyDown={onKey}>
            <ExpandButton side="before" />
            <Show when={s().causes.length || s().rootCap}>
              <div class="orghist-sect">
                <SectionLabel causal>Came from</SectionLabel>
                <Show when={s().causes.length} fallback={<p class="orghist-cap">{TRIGGER_NOT_RECORDED}</p>}>
                  <Steps items={s().causes} up byId={byId()} filters={props.filters} hrefWith={props.hrefWith} label="Came from" />
                </Show>
              </div>
            </Show>

            <div class="orghist-root" aria-current="true">
              <span class="orghist-root-eyebrow">This event</span>
              <span class="orghist-root-title">{root()?.headline ?? "This event"}</span>
              <Show when={root()}>
                {(r) => (
                  <span class="orghist-root-meta">
                    <Chip tone={outcomeChip(r().outcome).tone}>{outcomeChip(r().outcome).word}</Chip>
                    <span>
                      <span class="orghist-mono">{rowClock(r())}</span> · {projectWords(r())}
                      <Show when={decider(r())}>{(d) => <> · {d()}</>}</Show>
                    </span>
                  </span>
                )}
              </Show>
              <a class="orghist-root-detail" href={props.hrefWith({ event: props.root, chain: undefined })} data-chain-link>
                Open Event Detail
              </a>
            </div>

            <div class="orghist-sect">
              <SectionLabel causal>Led to</SectionLabel>
              <Show when={s().consequences.length} fallback={<p class="orghist-empty-line">No recorded consequence.</p>}>
                <Steps items={s().consequences} byId={byId()} filters={props.filters} hrefWith={props.hrefWith} label="Led to" />
              </Show>
            </div>
            <ExpandButton side="after" />

            <Show when={s().related.length}>
              <div class="orghist-sect">
                <SectionLabel>Related · not causes</SectionLabel>
                <Steps items={s().related} byId={byId()} filters={props.filters} hrefWith={props.hrefWith} label="Related, not causes" />
              </div>
            </Show>
          </div>
        )}
      </Show>
    </section>
  );
}

/** The decider's name on a card, when the reader may see it and it was recorded. */
const decider = (e: EventSummary): string | null => (e.actors && !isUnknown(e.actors.decidedBy) ? actorWord(e.actors.decidedBy) : null);

function SectionLabel(props: { causal?: boolean; children: string }) {
  return (
    <p class="orghist-sect-label">
      <span class="orghist-key" classList={{ "orghist-key-causal": props.causal }} aria-hidden="true" />
      {props.children}
    </p>
  );
}

/** One section's cards. `up`: Came from, where a card sits above what it leads into, so its edge's words
    come after it and its own causes before it. */
function Steps(props: { items: ChainItem[]; up?: boolean; byId: Map<string, EventSummary>; filters: HistoryFilters; hrefWith: Href; label?: string; nested?: boolean }) {
  return (
    <ol class="orghist-steps" classList={{ "orghist-steps-nested": props.nested, "orghist-steps-up": props.up }} aria-label={props.label}>
      <For each={props.items}>{(i) => <Step item={i} up={props.up} byId={props.byId} filters={props.filters} hrefWith={props.hrefWith} />}</For>
    </ol>
  );
}

function Step(props: { item: ChainItem; up?: boolean; byId: Map<string, EventSummary>; filters: HistoryFilters; hrefWith: Href }) {
  const i = () => props.item;
  const children = () => (
    <Show when={i().children.length}>
      <Steps items={i().children} up={props.up} byId={props.byId} filters={props.filters} hrefWith={props.hrefWith} nested />
    </Show>
  );
  const edge = () => (
    <Show when={i().words}>
      {(w) => (
        <p class="orghist-edge-words">
          <Show when={i().arrow}>{(a) => <span aria-hidden="true">{a() === "up" ? "↑" : "↓"}</span>}</Show>
          {w()}
        </p>
      )}
    </Show>
  );
  const cap = () => (
    <Show when={i().cap}>
      <p class="orghist-cap">{TRIGGER_NOT_RECORDED}</p>
    </Show>
  );
  return (
    <li class="orghist-step" data-link={i().edge?.link ?? "none"}>
      <Show
        when={props.up}
        fallback={
          <>
            <div class="orghist-step-body">
              {edge()}
              <Card item={i()} byId={props.byId} filters={props.filters} hrefWith={props.hrefWith} />
            </div>
            {cap()}
            {children()}
          </>
        }
      >
        {children()}
        {cap()}
        <div class="orghist-step-body">
          <Card item={i()} byId={props.byId} filters={props.filters} hrefWith={props.hrefWith} />
          {edge()}
        </div>
      </Show>
    </li>
  );
}

function Card(props: { item: ChainItem; byId: Map<string, EventSummary>; filters: HistoryFilters; hrefWith: Href }) {
  const e = () => props.byId.get(props.item.id)!;
  const chip = () => outcomeChip(e().outcome);
  const outside = () => outsideFilter(e(), props.filters.projects);
  return (
    <a class="orghist-ev" classList={{ "orghist-ev-boundary": outside() }} href={props.hrefWith({ event: props.item.id, chain: true })} data-chain-link>
      <span class="orghist-ev-title">{e().headline}</span>
      <Chip tone={chip().tone}>{chip().word}</Chip>
      <span class="orghist-ev-meta">
        <span class="orghist-mono">{rowClock(e())}</span> · {outside() ? OUTSIDE_FILTER : projectWords(e())}
        <Show when={!outside() && decider(e())}>{(d) => <> · {d()}</>}</Show>
      </span>
      <For each={props.item.also}>{(a) => <span class="orghist-ev-meta orghist-ev-also">{a.words}</span>}</For>
    </a>
  );
}
