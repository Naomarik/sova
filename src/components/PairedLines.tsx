import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { PairView } from "../../shared/protocol";
import { listPairs, resumePairing, unpairChats } from "../lib/api";
import { pairLinesOf } from "../lib/pair-lines";
import { Banner } from "./ui";

/** How often an open chat re-reads its pairings: a pause or an unpair from elsewhere shows within it. */
const REFRESH_MS = 20_000;

/** The partner of `sessionId` in `p`, and whether either direction is paused. */
export function pairLine(p: PairView, sessionId: string): { partner: PairView["a"]; paused: boolean } {
  const partner = p.a.sessionId === sessionId ? p.b : p.a;
  return { partner, paused: p.a.paused || p.b.paused };
}

/**
 * A paired chat's lines (§app.overseer/pairs "What the user sees"): one per pairing, "Paired with
 * <partner>" (a link to it) with Unpair, and "Paused: note limit reached" with Resume while either
 * direction is paused.
 */
export function PairedLines(props: { sessionId: string | undefined }) {
  const id = createMemo(() => props.sessionId);
  const [busy, setBusy] = createSignal<string | null>(null);
  const [error, setError] = createSignal<{ pairing: string; text: string } | null>(null);
  const { pairs, load } = pairLinesOf(id, async (sid) => (await listPairs(sid)).pairs, () => setError(null));
  const timer = setInterval(() => void load(), REFRESH_MS);
  onCleanup(() => clearInterval(timer));
  const run = async (pairing: string, f: (id: string) => Promise<unknown>) => {
    setBusy(pairing);
    setError(null);
    try {
      await f(pairing);
    } catch (err) {
      setError({ pairing, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
      await load();
    }
  };
  return (
    <For each={pairs()}>
      {(p) => {
        const line = () => pairLine(p, id() ?? "");
        return (
          <Banner
            tone={line().paused ? "warn" : "info"}
            size="compact"
            icon="network"
            title={
              <>
                Paired with <a href={`#/s/${encodeURIComponent(line().partner.path)}`} title={line().partner.title}>{line().partner.title}</a>
              </>
            }
            body={error()?.pairing === p.id ? error()!.text : line().paused ? "Paused: note limit reached" : undefined}
            action={
              <span class="cluster">
                <Show when={line().paused}>
                  <button type="button" class="button button-sm" disabled={busy() === p.id} onClick={() => void run(p.id, resumePairing)}>
                    Resume
                  </button>
                </Show>
                <button type="button" class="button button-sm button-ghost" disabled={busy() === p.id} onClick={() => void run(p.id, unpairChats)}>
                  Unpair
                </button>
              </span>
            }
          />
        );
      }}
    </For>
  );
}
