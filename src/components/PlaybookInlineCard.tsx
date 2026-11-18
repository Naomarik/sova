import { createMemo, Show, useContext } from "solid-js";
import { runStatus } from "../lib/playbook-card";
import { PlaybookCard, PlaybookInlineContext } from "./PlaybookCard";

/**
 * A playbook's card where it stands in the conversation: before Start the setup card, edited and
 * started there; after Start the same card as the read-only record of what was agreed (the run
 * itself is on its strip above the message box). Drawn for the row the page places for the run
 * (lib/playbook-card-rows), and under a new chat's opening lines, which have no rows yet. Outside a
 * chat that shows cards (a read-only watch) it draws nothing.
 */
export function PlaybookInlineCard(props: { run: string; /** The chat holds nothing but this card: the view lands on it when the chat opens. */ land?: boolean }) {
  const host = useContext(PlaybookInlineContext);
  const run = createMemo(() => host?.run(props.run));
  return (
    <Show when={host}>
      {(h) => (
        <Show when={run()}>
          {(view) => (
            <PlaybookCard
              inline
              shown
              land={props.land}
              run={view()}
              store={h().store}
              host={h().host}
              here={h().chat.path}
              // The record never says how the chat stands now: the strip does.
              status={runStatus(view(), null, h().store.starting(view().id))}
              onMinimize={() => {}}
            />
          )}
        </Show>
      )}
    </Show>
  );
}
