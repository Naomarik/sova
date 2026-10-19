/**
 * Draws the row place (src/lib/row-place.ts, §app.extensions/row-chips) inside line 3's meta text:
 * Sova's built-ins first, each after a " · " exactly as the row always drew its readiness badge, then
 * what extensions add with RowAdded. Extension content is data drawn as plain text, never markup and
 * never a control: the row is the link to its session.
 */
import { For, Index, Show, useContext } from "solid-js";
import type { SessionSummary } from "../../shared/protocol";
import { RowPlaceContext, rowChipTitle, type RowBuiltIn, type RowChip } from "../lib/row-place";
import "../extensions.css";

/** Line 3's place for one session: the built-ins' items, then the extensions' chips. */
export function RowPlaceView(props: { session: SessionSummary; builtIns: readonly RowBuiltIn[] }) {
  const chips = useContext(RowPlaceContext);
  return (
    <>
      {/* By position, not by object: a changed badge updates its words in place, as the row's own
          <Show> did, instead of building a new span for every fresh item. */}
      <Index each={props.builtIns.length === 1 ? props.builtIns[0]!.items(props.session) : props.builtIns.flatMap((b) => b.items(props.session))}>
        {(item) => (
          <>
            {" · "}
            <span class={item().class} title={item().title}>
              {item().label}
            </span>
          </>
        )}
      </Index>
      <Show when={chips(props.session)}>{(c) => <RowAdded chips={c()} />}</Show>
    </>
  );
}

const TONE_CLASS: Record<RowChip["tone"], string> = { ok: " session-row-chip-ok", warn: " session-row-chip-warn", error: " session-row-chip-error", info: " session-row-chip-info", muted: "" };

/** What extensions add to one row: each chip a tone dot and its words, naming its extension. */
export function RowAdded(props: { chips: readonly RowChip[] }) {
  return (
    <For each={props.chips}>
      {(chip) => (
        <>
          {" · "}
          <span class={`session-row-chip${TONE_CLASS[chip.tone]}`} title={rowChipTitle(chip)}>
            <span class="chip-dot" aria-hidden="true" />
            {chip.label}
            <span class="visually-hidden">, from {chip.extensionTitle}</span>
          </span>
        </>
      )}
    </For>
  );
}
