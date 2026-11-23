import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { PairView } from "../../shared/protocol";
import { listPairs, resumePairing, unpairChats } from "../lib/api";
import { pairFoldOf, pairLinesOf } from "../lib/pair-lines";
import { Banner } from "./ui";

/** How often an open chat re-reads its pairings: a pause or an unpair from elsewhere shows within it. */
const REFRESH_MS = 20_000;

let lists = 0;

/** The partner of `sessionId` in `p`, and whether either direction is paused. */
export function pairLine(p: PairView, sessionId: string): { partner: PairView["a"]; paused: boolean } {
  const partner = p.a.sessionId === sessionId ? p.b : p.a;
  return { partner, paused: p.a.paused || p.b.paused };
}

/**
 * A paired chat's lines (§app.overseer/pairs "What the user sees"): one per pairing, "Paired with
 * <partner>" (a link to it) with Unpair, and "Paused: note limit reached" with Resume while either
 * direction is paused. From 3 pairings they fold into one line, "Paired with N chats" (with "N paused"
 * while any is paused), and Show All opens the same lines in a list under it.
 */
export function PairedLines(props: { sessionId: string | undefined }) {
  const id = createMemo(() => props.sessionId);
  const [busy, setBusy] = createSignal<string | null>(null);
  const [error, setError] = createSignal<{ pairing: string; text: string } | null>(null);
  const { pairs, load } = pairLinesOf(id, async (sid) => (await listPairs(sid)).pairs, () => setError(null));
  const fold = pairFoldOf(id, pairs);
  const listId = `pair-list-${++lists}`;
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
  /** One pairing's line: "Paired with <partner>", Unpair, and Resume while paused. */
  const Line = (lp: { pair: PairView }) => {
    const p = lp.pair;
    const line = () => pairLine(p, id() ?? "");
    return (
      <Banner
        tone={line().paused ? "warn" : "info"}
        size="compact"
        icon="link"
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
  };
  return (
    <Show when={fold.state() !== "plain"} fallback={<For each={pairs()}>{(p) => <Line pair={p} />}</For>}>
      <Banner
        tone={fold.tone()}
        size="compact"
        icon="link"
        title={<>Paired with {fold.count()} chats</>}
        body={fold.paused() > 0 ? `${fold.paused()} paused` : undefined}
        action={
          <button type="button" class="button button-sm" aria-expanded={fold.state() === "open"} aria-controls={listId} onClick={() => fold.toggle()}>
            {fold.state() === "open" ? "Hide" : "Show All"}
          </button>
        }
      />
      <Show when={fold.state() === "open"}>
        <ul class="pair-list" id={listId} aria-label={`${fold.count()} pairings`}>
          <For each={pairs()}>
            {(p) => (
              <li>
                <Line pair={p} />
              </li>
            )}
          </For>
        </ul>
      </Show>
    </Show>
  );
}
