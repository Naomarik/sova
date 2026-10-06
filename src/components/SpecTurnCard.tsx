import { createResource, createSignal, For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import type { SpecClaimText, SpecTurnInfo, SpecTurnItemInfo } from "../../shared/protocol";
import { fetchSpecClaim } from "../lib/api";
import { clockTime } from "../lib/format";
import { areas, byArea, changeWord, leftOpen, specTurnLine } from "../lib/spec-card";
import { copyText } from "../lib/ui-state";
import { shortSha } from "../lib/worktrees";
import { useChangesSession } from "./ChangesViewer";
import { Markdown } from "./Markdown";
import { CopyButton, Icon, trapFocus } from "./ui";

/**
 * The spec card (§chat.spec-card/card): what a run did to the product documentation, from the
 * mode extension's `spec-turn` record. One quiet line, collapsed every time; opened, the § the run
 * changed by area, the rest it landed, one row for what arrived from the default branch, and what it
 * left open. A § opens the claim sheet (§chat.spec-card/claim-sheet) when the card knows its session.
 */
export function SpecTurnCard(props: { turn: SpecTurnInfo; entryId: string; time?: string }) {
  const d = () => props.turn;
  const session = useChangesSession() ?? undefined;
  const [claim, setClaim] = createSignal<string | null>(null);
  const arrivedAreas = () => d().arrived?.byArea ?? [];
  return (
    <details class="disclosure spec-turn">
      <summary class="disclosure-summary spec-turn-summary">
        <Icon name="chevron-right" small class="icon-twist" />
        <span class="spec-turn-line">{specTurnLine(d())}</span>
        <Show when={props.time}>{(t) => <span class="spec-turn-time text-mono">{clockTime(t())}</span>}</Show>
      </summary>
      <div class="spec-turn-body">
        <Show when={d().own.length}>
          <ItemGroups heading="Changed this run" items={d().own} open={session ? setClaim : undefined} />
        </Show>
        <Show when={d().landed.length}>
          <ItemGroups heading="Landed this run" items={d().landed} open={session ? setClaim : undefined} />
        </Show>
        <Show when={d().arrived?.count ? d().arrived : undefined}>
          {(a) => (
            <details class="spec-turn-arrived">
              <summary class="spec-turn-arrived-summary">
                <span class="spec-turn-arrived-text">
                  <span class="spec-turn-arrived-title">
                    {a().count} § arrived from {a().from}, in {areas(a().byArea.length)}
                  </span>
                  <span class="text-caption text-muted">Already on {a().from}; this run didn't change them.</span>
                </span>
                <span class="spec-turn-arrived-action text-caption">
                  <span class="spec-turn-show">Show</span>
                  <span class="spec-turn-hide">Hide</span>
                </span>
              </summary>
              <ul class="spec-turn-areas" aria-label={`Areas that arrived from ${a().from}`}>
                <For each={arrivedAreas()}>
                  {(row) => (
                    <li class="spec-turn-area-row">
                      <span class="text-mono">{row.area}</span>
                      <span class="text-caption text-muted text-num">{row.count} §</span>
                    </li>
                  )}
                </For>
              </ul>
            </details>
          )}
        </Show>
        <Show when={leftOpen(d())}>
          <section class="spec-turn-open" aria-label="Left open">
            <h3 class="spec-turn-heading">Left open</h3>
            <ul class="spec-turn-notes text-caption">
              <For each={d().gate.unpromoted}>
                {(u) => (
                  <li>
                    {u.draft ? (
                      <>
                        Draft <span class="text-mono">{u.draft}</span> has
                      </>
                    ) : (
                      "Draft records for"
                    )}{" "}
                    <span class="text-mono">{u.ids.join(", ")}</span> {u.draft ? "not promoted" : "aren't promoted"}
                    {u.deferred ? `: ${u.deferred}` : "."}
                  </li>
                )}
              </For>
              <Show when={d().gate.stale.length}>
                <li>
                  Not promoted on the default branch: <span class="text-mono">{d().gate.stale.join(", ")}</span>.
                </li>
              </Show>
              <For each={d().gate.unmapped}>
                {(u) => (
                  <li>
                    <span class="text-mono">{u.path}</span> changed and no claim maps it{u.plumbing ? `: ${u.plumbing}` : "."}
                  </li>
                )}
              </For>
              <Show when={d().check.incomplete}>{(why) => <li>The check was incomplete: {why()}</li>}</Show>
              <Show when={d().check.override}>{(why) => <li>Override: {why()}</li>}</Show>
              <Show when={!d().check.ok && d().check.problem}>{(p) => <li>The check didn't pass: {p()}.</li>}</Show>
            </ul>
          </section>
        </Show>
      </div>
      <Show when={claim() ? session : undefined}>
        {(s) => <ClaimSheet session={s().path} entryId={props.entryId} id={claim()!} onClose={() => setClaim(null)} />}
      </Show>
    </details>
  );
}

function ItemGroups(props: { heading: string; items: SpecTurnItemInfo[]; open?: (id: string) => void }) {
  return (
    <section class="spec-turn-section" aria-label={props.heading}>
      <h3 class="spec-turn-heading">{props.heading}</h3>
      <For each={byArea(props.items)}>
        {(g) => (
          <>
            <p class="spec-turn-area text-caption text-muted">
              <span class="text-mono">{g.area}</span> · {g.items.length} §
            </p>
            <ul class="spec-turn-items">
              <For each={g.items}>
                {(it) => (
                  <li>
                    <Show
                      when={props.open}
                      fallback={
                        <div class="spec-turn-item">
                          <ItemText item={it} />
                        </div>
                      }
                    >
                      {(open) => (
                        <button type="button" class="spec-turn-item spec-turn-item-button" aria-haspopup="dialog" title={`Read ${it.id}`} onClick={() => open()(it.id)}>
                          <ItemText item={it} />
                        </button>
                      )}
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </>
        )}
      </For>
    </section>
  );
}

function ItemText(props: { item: SpecTurnItemInfo }) {
  return (
    <>
      <span class="spec-turn-item-main">
        <span class="spec-turn-id text-mono">{props.item.id}</span>
        <Show when={props.item.what}>{(w) => <span class="spec-turn-what">{w()}</span>}</Show>
      </span>
      <Show when={changeWord(props.item.change)}>{(c) => <span class="spec-turn-change text-caption text-muted">{c()}</span>}</Show>
    </>
  );
}

/** Where a sheet's text came from, in a line. */
function sourceLine(c: SpecClaimText): string {
  if (c.source === "commit") return `As of ${c.rev ? shortSha(c.rev) : "the run's commit"}.`;
  if (c.source === "captured") return "As the run left it, before any commit.";
  return "Current text, not as of this turn.";
}

/** The claim sheet (§chat.spec-card/claim-sheet): one claim's text as of the turn, and before it. */
function ClaimSheet(props: { session: string; entryId: string; id: string; onClose(): void }) {
  const [text] = createResource(() => fetchSpecClaim(props.session, props.entryId, props.id));
  const [tab, setTab] = createSignal<"after" | "before">("after");
  const shown = () => {
    const c = text();
    if (!c) return undefined;
    return tab() === "before" ? c.before : c.after;
  };
  const titleId = `spec-claim-${props.entryId}`;
  return (
    <Portal>
      <div class="scrim" onClick={() => props.onClose()} />
      <div
        class="modal modal-wide spec-claim"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={(el) => trapFocus(el)}
        onKeyDown={(e) => {
          if (e.key === "Escape") props.onClose();
        }}
      >
        <div class="sheet-grip" aria-hidden="true" />
        <div class="modal-head">
          <h2 class="modal-title text-mono" id={titleId}>
            {props.id}
          </h2>
        </div>
        <div class="modal-body spec-claim-body">
          <Show when={!text.loading} fallback={<p role="status">Reading the claim…</p>}>
            <Show when={!text.error} fallback={<p role="alert">Couldn't read the claim: {(text.error as Error)?.message ?? "unknown error"}</p>}>
              <Show when={text()}>
                {(c) => (
                  <>
                    <p class="text-caption text-muted">{sourceLine(c())}</p>
                    <Show when={c().source !== "current" && c().before !== undefined}>
                      <div class="tabs spec-claim-tabs" role="tablist" aria-label="Which text">
                        <For each={[["after", "This turn"], ["before", "Before"]] as const}>
                          {([key, label]) => (
                            <button
                              type="button"
                              role="tab"
                              class={tab() === key ? "tab tab-active" : "tab"}
                              aria-selected={tab() === key ? "true" : "false"}
                              aria-controls={`${titleId}-panel`}
                              tabindex={tab() === key ? 0 : -1}
                              onClick={() => setTab(key)}
                            >
                              {label}
                            </button>
                          )}
                        </For>
                      </div>
                    </Show>
                    <div class="spec-claim-text" id={`${titleId}-panel`} role="tabpanel">
                      <Show when={shown()} fallback={<p class="text-muted">{tab() === "before" ? "It didn't exist before the turn." : "It doesn't exist after the turn."}</p>}>
                        {(t) => <Markdown text={t()} />}
                      </Show>
                    </div>
                  </>
                )}
              </Show>
            </Show>
          </Show>
        </div>
        <div class="modal-foot">
          <CopyButton label="Copy §" text={() => props.id} onCopy={(t) => copyText(t, "Copied the § id.")} />
          <span class="modal-spacer" />
          <button type="button" class="button" onClick={() => props.onClose()}>
            Close
          </button>
        </div>
      </div>
    </Portal>
  );
}
