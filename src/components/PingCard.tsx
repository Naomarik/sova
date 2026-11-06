import { For, useContext } from "solid-js";
import { CardContext } from "../lib/card-controls";
import { pingCardView, type PingCallDetails } from "../lib/pings";
import { Icon } from "./ui";
import "../data-cards.css";

/**
 * A ping's card in the chat that pinged (§app.overseer-pings/tool "Its card"): drawn at its `overseer_ping` call,
 * "Told the Overseer" with its kind and summary, then one line per outcome. Sova revises the card it keeps in place
 * (lib/card-controls reads it again), with no model turn; until the page has it, the call's own words draw it.
 */
export function PingCard(props: { details: PingCallDetails; args: unknown }) {
  const ctx = useContext(CardContext);
  const view = () => pingCardView(props.details, props.args, props.details.card ? ctx?.card(props.details.card) : undefined);
  return (
    <div class="transcript-card" data-card-id={props.details.card}>
      <section class="card data-card data-card-status ping-card" aria-label={`${view().title}: ${view().line}`}>
        <div class="card-head">
          <h3 class="card-title">
            <Icon name="eye" small />
            {view().title}
          </h3>
        </div>
        <div class="card-body data-status-body">
          <p class="data-status-line">{view().line}</p>
          <For each={view().outcomes}>{(line) => <p class="data-status-detail">{line}</p>}</For>
        </div>
      </section>
    </div>
  );
}
