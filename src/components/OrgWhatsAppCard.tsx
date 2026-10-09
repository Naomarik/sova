import { createResource, createSignal, For, onCleanup, Show } from "solid-js";
import type { OrgSenderView } from "../../shared/outreach";
import { getOrgSender, numberWords, putOrgSender } from "../lib/outreach";
import { toast } from "../lib/ui-state";
import { Banner } from "./ui";

/** How often the card reads the numbers again while shown, like the org page itself. */
const LIVE_MS = 10_000;

/**
 * An organization's WhatsApp Number card (§app.outreach/org-sender), on its page's Workspace tab: Default or one
 * of the numbers Settings → Outreach lists, saved at once. Host-local, so only an organization on this host shows
 * the select; one on another host points at its own host's page.
 */
export function OrgWhatsAppCard(props: { orgId: string; remoteHost: string | null }) {
  const [view, { mutate, refetch }] = createResource(
    () => (props.remoteHost ? null : props.orgId),
    (id) => getOrgSender(id),
  );
  // Settings → Outreach opens over this page, so a number added, removed or relabelled there shows on the next read.
  const live = setInterval(() => !document.hidden && !busy() && void refetch(), LIVE_MS);
  onCleanup(() => clearInterval(live));
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const pick = async (value: string) => {
    setBusy(true);
    try {
      const next = await putOrgSender(props.orgId, value || null);
      mutate(next);
      setError(null);
      toast(`${numberWords(next.effective ?? { label: "The default" })} sends this organization's messages.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const v = (): OrgSenderView | undefined => (view.error ? undefined : view.latest);
  return (
    <section class="card orgs-section" aria-labelledby="orgs-whatsapp">
      <div class="orgs-head">
        <h2 class="orgs-h2" id="orgs-whatsapp">
          WhatsApp Number
        </h2>
      </div>
      <Show when={!props.remoteHost} fallback={<p class="orgs-line">Pick its WhatsApp number on its own host's page.</p>}>
        <Show when={view.error}>
          <Banner tone="error" title="The WhatsApp numbers can't be read." body="Nothing changed. Open this tab again to retry." />
        </Show>
        <Show when={v()}>
          {(o) => (
            <Show when={!o().off} fallback={<p class="orgs-line">Outreach is off on this host: set it up in Settings → Outreach.</p>}>
              <Show when={o().gone}>
                {(gone) => <Banner tone="warn" title={`The number this organization picked (${gone().replace(/^(local|peer):/, "")}) is gone from Settings → Outreach, so its messages go from the default, ${numberWords(o().default ?? { label: "This host" })}.`} />}
              </Show>
              <label class="field">
                <span class="field-label">Sends from</span>
                <span class="select-wrap">
                  <select class="select" aria-describedby="orgs-whatsapp-hint" disabled={busy()} onChange={(e) => void pick(e.currentTarget.value)}>
                    <option value="" selected={!o().choice || !!o().gone}>
                      Default ({numberWords(o().default ?? { label: "none" })})
                    </option>
                    <For each={o().options}>
                      {(n) => (
                        <option value={n.id} selected={o().choice === n.id && !o().gone}>
                          {numberWords(n)}
                        </option>
                      )}
                    </For>
                  </select>
                </span>
              </label>
              <p class="field-hint" id="orgs-whatsapp-hint">
                Messages to this organization's people go from this number. When it is down or at its limit, they wait or fail; they never go from another number.
              </p>
            </Show>
          )}
        </Show>
        <Show when={error()}>{(e) => <Banner tone="error" title={`The number wasn't changed: ${e()}`} />}</Show>
      </Show>
    </section>
  );
}
