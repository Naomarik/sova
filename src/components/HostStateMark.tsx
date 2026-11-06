import { Show } from "solid-js";
import { hostLabel, peerInfo, peerReading, peerUnavailable, readingOf } from "../lib/mesh";
import { hostMark } from "../lib/mesh-details";

/**
 * A peer session's host in a head (§mesh.remote-sessions/head-host-state): a dot in the host
 * filter's tone and the name in ink. The state's words live in the title and accessible name only;
 * while the mesh hasn't said, it is the plain muted label it always was.
 */
export function HostStateMark(props: { host: string; class?: string }) {
  const name = () => hostLabel(props.host);
  const mark = () => {
    const p = peerInfo(props.host);
    return hostMark(name(), p ? peerReading(p) : null, p ? peerUnavailable(p) : null);
  };
  return (
    <Show
      when={mark()}
      fallback={
        <span class={`host-state-mark ${props.class ?? ""}`} title={`This session lives on ${name()}`}>
          on {name()}
        </span>
      }
    >
      {(m) => (
        <span class={`host-state-mark host-state-mark-known ${props.class ?? ""}`} title={m().title} aria-label={m().title} role="img" data-testid="session-host-mark" data-host-state={readingOf(props.host) ?? undefined}>
          <span class={`chip-dot host-filter-${m().tone}`} aria-hidden="true" />
          <span class="host-state-mark-name">{name()}</span>
        </span>
      )}
    </Show>
  );
}
