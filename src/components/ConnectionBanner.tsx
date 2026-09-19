import { Match, Switch } from "solid-js";
import { clockTime } from "../lib/format";
import type { ReconnectingSocket } from "../lib/socket";
import { Banner } from "./ui";

/**
 * Connection trouble at the top of the transcript (DESIGN_NOTES §9 "Connection"). Chat shows
 * only the gave-up banner (retrying lives in the composer reason); watch also shows retrying.
 */
export function ConnectionBanner(props: { socket: ReconnectingSocket; watch?: boolean; lastUpdate?: string | null }) {
  return (
    <Switch>
      <Match when={props.watch && props.socket.status() === "reconnecting"}>
        <Banner
          tone="warn"
          title="Stopped watching. The connection dropped."
          body={
            <>
              <span>{props.lastUpdate ? <>What's shown is up to <code>{clockTime(props.lastUpdate)}</code>. </> : null}Reconnecting…</span>
            </>
          }
        />
      </Match>
      <Match when={props.socket.status() === "failed"}>
        <Banner
          tone="error"
          title="Lost the connection to the pi-web server."
          body={
            <>
              Nothing in the session changed. Check <code>npm run dev:server</code> is running, then retry.
            </>
          }
          action={
            <button type="button" class="button button-sm" onClick={() => props.socket.retry()}>
              Reconnect
            </button>
          }
        />
      </Match>
    </Switch>
  );
}
