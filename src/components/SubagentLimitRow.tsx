import { createEffect, createMemo, createResource, createSignal, For, onCleanup, Show, untrack } from "solid-js";
import type { JoinedProfile } from "../../shared/profiles";
import { fetchProfiles, switchProfile } from "../lib/api";
import { chatProfileOf } from "../lib/chat-profile-state";
import { modelLabel } from "../lib/format";
import { limitLine, limitOffers, switchRefused } from "../lib/profile-switch";
import { exhaustedProvider, providerLabel } from "../lib/subagent-limit";
import { openProfiles } from "../lib/settings-nav";
import { useHostScope } from "../lib/host-scope";
import { announce } from "../lib/ui-state";
import { Banner } from "./ui";

/**
 * The limit row (§chat.subagent-profiles/limit-row): under a turn error that ended on a usage limit,
 * a calm row naming the model the chat was actually running, with up to two taps, Switch This Chat
 * to {profile}, for the first two of your profiles whose Models part (the chat's own model included)
 * spends nothing of the exhausted provider. A tap switches the whole Models part as a pick in the
 * mode menu does (checked first, waiting for a running reply, all or nothing); the thread's line
 * above the composer then says where the chat is. Nothing switches by itself. With no such profile
 * the row links to Settings → Profiles.
 *
 * Only a failure whose provider is known is certain enough: `exhaustedProvider` answers from the
 * error's own words or the failed turn's own provider (handed over with the error), so the row
 * never appears for an auth, network or policy error, and never guesses a worker's from this
 * chat's model.
 */
/** The newest limit row of each chat, by path: a retried limit draws one error row per try, and
    only the last one carries the limit row, so it never reads as a duplicate. */
const newest = new Map<string, ReturnType<typeof createSignal<number>>>();
let mounted = 0;
const newestOf = (path: string) => {
  let s = newest.get(path);
  if (!s) newest.set(path, (s = createSignal(0)));
  return s;
};

export function SubagentLimitRow(props: { path: string; message: string; provider?: string; model?: string }) {
  const host = useHostScope();
  const limited = () => exhaustedProvider(props.message, props.provider);
  // Each row that names a limit takes the next number when it mounts; rows mount in thread order.
  const [latest, setLatest] = untrack(() => newestOf(props.path));
  let mine = 0;
  createEffect(() => {
    if (limited() && !mine) setLatest((mine = ++mounted));
  });
  const provider = () => (limited() && latest() === mine ? limited() : null);
  // Your profiles are what it offers, so the listing needs no folder.
  const [listing, { refetch }] = createResource(provider, () => fetchProfiles(null, host()));
  /** The chat's own profile state (its `chat_profile` message), for "(edited)" and its current profile. */
  const chat = () => chatProfileOf(props.path);
  // A row mounted before the view holds its chat gets "Open the chat first" from a read; retry
  // a few times, then rest on the link.
  createEffect(() => {
    if (!provider() || !listing.error) return;
    let tries = 0;
    const timer = setInterval(() => {
      if (++tries > 3) return clearInterval(timer);
      void refetch();
    }, 1500);
    onCleanup(() => clearInterval(timer));
  });
  const [busy, setBusy] = createSignal<string | null>(null);
  const [error, setError] = createSignal<{ title: string; body: string } | null>(null);
  /** The profile this chat switched to from here: the row rests, the thread's line says the rest. */
  const [switched, setSwitched] = createSignal<string | null>(null);
  const offers = createMemo((): JoinedProfile[] => {
    const l = listing.error ? undefined : listing();
    const p = provider();
    if (!l?.joined || !p) return [];
    const c = chat()?.current;
    const rows = l.joined.map((r) => ({ ...r, setsModel: !!r.session?.model }));
    return limitOffers(rows, p, { key: c ? (rows.find((r) => (c.key ? r.key === c.key : r.id === c.id))?.key ?? null) : null, edited: !!c?.edited });
  });
  /** The model the failed turn ran, by its catalog name; the provider when the server didn't say. */
  const modelName = () => (props.model ? (modelLabel(props.model) ?? props.model) : providerLabel(provider()!));

  const choose = async (r: JoinedProfile) => {
    if (busy() || switched()) return;
    setBusy(r.key);
    setError(null);
    try {
      await switchProfile(props.path, r.id, host());
      setSwitched(r.name);
    } catch (err) {
      const why = (err instanceof Error ? err.message : String(err)).replace(/\.$/, "");
      const refused = switchRefused(r.name, why);
      setError(refused);
      announce(`${refused.title} ${refused.body}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Show when={provider()}>
      <Show when={error()}>{(e) => <Banner tone="error" title={e().title} body={e().body} />}</Show>
      <Banner
        tone="info"
        title={limitLine(modelName())}
        action={
          <Show when={!switched()}>
            <Show
              when={offers().length > 0}
              fallback={
                <button type="button" class="button button-sm" onClick={() => openProfiles({ ...(host() ? {} : { path: props.path }), part: "models" })}>
                  Manage Profiles
                </button>
              }
            >
              <div class="button-row">
                <For each={offers()}>
                  {(r) => (
                    <button type="button" class="button button-sm" aria-disabled={busy() ? "true" : undefined} onClick={() => void choose(r)}>
                      {busy() === r.key ? "Switching…" : `Switch This Chat to ${r.name}`}
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </Show>
        }
      />
    </Show>
  );
}
