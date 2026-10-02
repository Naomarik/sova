import { createEffect, createResource, createSignal, onCleanup, Show } from "solid-js";
import { getSubagentProfiles, pickSubagentProfile } from "../lib/api";
import { exhaustedProvider, limitAlternative, providerLabel } from "../lib/subagent-limit";
import { openSettings, setSubagentSettingsPath } from "../lib/settings-nav";
import { useHostScope } from "../lib/host-scope";
import { announce } from "../lib/ui-state";
import { Banner } from "./ui";

/**
 * The limit row: under a turn error that ended on a usage
 * limit, one calm offer — Switch This Chat to the first profile whose workers never spend the
 * exhausted provider, fallbacks included. Nothing switches by itself, and there is no near-limit
 * hint. With no such profile it links to Settings → Subagents instead, and after the switch it
 * says so once and rests, rather than offering the next profile.
 *
 * Only a failure whose provider is known is certain enough: `exhaustedProvider` answers from the
 * error's own words or the failed turn's own provider (handed over with the error), so the row
 * never appears for an auth, network or policy error, and never guesses a worker's from this
 * chat's model.
 */
export function SubagentLimitRow(props: { path: string; message: string; provider?: string }) {
  const host = useHostScope();
  const provider = () => exhaustedProvider(props.message, props.provider);
  const [info, { mutate, refetch }] = createResource(provider, () => getSubagentProfiles(props.path, host()));
  // A row mounted before the view holds its chat gets "Open the chat first" from this read; retry
  // a few times, then rest on the link. A held chat answers on the first retry at the latest.
  createEffect(() => {
    if (!provider() || !info.error) return;
    let tries = 0;
    const timer = setInterval(() => {
      if (++tries > 3) return clearInterval(timer);
      void refetch();
    }, 1500);
    onCleanup(() => clearInterval(timer));
  });
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  /** The profile this chat switched to from here; the row rests on that answer. */
  const [switched, setSwitched] = createSignal<string | null>(null);
  const alternative = () => (!info.error && info() && provider() ? limitAlternative(info()!, provider()!) : undefined);

  const choose = async () => {
    const next = alternative();
    if (!next || busy() || switched()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await pickSubagentProfile(props.path, next.id, host());
      mutate(r);
      setSwitched(r.current.name);
      announce(`Subagent profile: ${r.current.name}. Running workers keep their models.`);
    } catch (err) {
      setError((err instanceof Error ? err.message : String(err)).replace(/\.$/, ""));
    } finally {
      setBusy(false);
    }
  };

  const manage = () => {
    setSubagentSettingsPath(host() ? undefined : props.path);
    openSettings("subagents");
  };

  return (
    <Show when={provider()}>
      {(exhausted) => (
        <>
          <Show when={error()}>{(e) => <Banner tone="error" title="Couldn't switch subagent profiles." body={`${e()}. Your profile is unchanged.`} />}</Show>
          <Show
            when={switched()}
            fallback={
              <Banner
                tone="info"
                title={`This chat's subagents spend ${providerLabel(exhausted())}, which is at its usage limit.`}
                body="A switch is this chat's own, for later subagent work only: running workers and this chat's own model stay as they are."
                action={
                  <Show
                    when={alternative()}
                    fallback={
                      <button type="button" class="button button-sm" onClick={manage}>
                        Manage Subagent Profiles
                      </button>
                    }
                  >
                    {(p) => (
                      <button type="button" class="button button-sm" disabled={busy()} onClick={() => void choose()}>
                        {busy() ? "Switching…" : `Switch This Chat to ${p().name}`}
                      </button>
                    )}
                  </Show>
                }
              />
            }
          >
            {(name) => (
              <Banner
                tone="success"
                title={`Switched to ${name()}.`}
                body="Later subagent work in this chat uses it. Running workers and this chat's own model stayed as they are."
              />
            )}
          </Show>
        </>
      )}
    </Show>
  );
}
