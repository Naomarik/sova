import { createSignal, For, Show } from "solid-js";
import { getPreviews, mintPreview, turnOffPreview } from "../lib/api";
import { createPoll } from "../lib/poll";
import { activePreviews, parsePort, PREVIEW_EXPIRY_CHOICES, previewWarning, runningLine } from "../lib/previews";
import { expiresWord } from "../lib/session-shares";
import { toast } from "../lib/ui-state";
import { Banner } from "./ui";

const POLL_MS = 5_000;
const errText = (x: unknown) => (x instanceof Error ? x.message : String(x));

/**
 * A project's preview links (§mesh.public/preview-card): each active one with its port, expiry,
 * whether the app answers on it, Copy Link (only for a link minted in this page: the link is shown
 * once, its label never stored) and Turn Off; then New Preview with the warning. Read every 5
 * seconds while the page shows.
 */
export function PreviewsCard(props: { orgId: string; projectId: string }) {
  const poll = createPoll(() => getPreviews(props.orgId, props.projectId), POLL_MS);
  /** Links minted in this page, by preview id: the only place a link can be copied from. */
  const [links, setLinks] = createSignal<Record<string, string>>({});
  const [port, setPort] = createSignal("");
  const [days, setDays] = createSignal<number>(PREVIEW_EXPIRY_CHOICES[0]);
  const [formError, setFormError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [armed, setArmed] = createSignal<string | null>(null);

  const list = () => activePreviews(poll.data()?.previews ?? []);
  const address = () => poll.data()?.address;
  /** The number typed, for the warning (named even when the port is refused). */
  const typed = () => (/^\d{1,5}$/.test(port().trim()) ? Number(port().trim()) : null);

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast("Link copied.");
    } catch {
      toast("Couldn't copy the link. Select it and copy it by hand.");
    }
  };

  const create = async (e: Event) => {
    e.preventDefault();
    if (busy()) return;
    const p = parsePort(port());
    if ("error" in p) return setFormError(p.error);
    setBusy(true);
    setFormError(null);
    try {
      const made = await mintPreview({ orgId: props.orgId, projectId: props.projectId, port: p.port, days: days() });
      setLinks({ ...links(), [made.preview.id]: made.url });
      setPort("");
      if (made.linkWarning) toast(made.linkWarning);
      void copy(made.url);
      poll.refetch();
    } catch (x) {
      setFormError(errText(x));
    } finally {
      setBusy(false);
    }
  };

  const off = async (id: string) => {
    if (armed() !== id) return setArmed(id);
    setArmed(null);
    try {
      await turnOffPreview(id);
      toast("Preview turned off.");
    } catch (x) {
      toast(`Couldn't turn it off. ${errText(x)}`);
    }
    poll.refetch();
  };

  return (
    <section class="card orgs-section previews-card" aria-labelledby="project-previews">
      <h2 class="orgs-h2" id="project-previews">
        Previews
      </h2>
      <p class="orgs-line">Share a web app running on this computer, the whole site at its own address, until you turn it off.</p>
      <Show when={poll.error() && !poll.data()}>
        <p class="field-error">Couldn't read this project's previews. {poll.error()}</p>
      </Show>
      <Show when={address() && !address()!.url}>
        <Banner tone="info" title="Preview links aren't set up." body={address()!.message ?? "Set a preview address in Settings → Public links on the gateway."} />
      </Show>
      <Show when={list().length > 0}>
        <ul class="list previews-list">
          <For each={list()}>
            {(v) => (
              <li class="list-row previews-row">
                <div class="list-main">
                  <p class="list-title">
                    Port <span class="text-mono">{v.port}</span>
                    <span class={v.running ? "chip chip-success" : "chip chip-warn"}>
                      <span class="chip-dot" aria-hidden="true" />
                      {runningLine(v)}
                    </span>
                  </p>
                  <p class="list-meta">{expiresWord(v.expiresAt, Date.now())}</p>
                  <Show when={links()[v.id]}>{(url) => <p class="list-meta text-mono previews-url">{url()}</p>}</Show>
                </div>
                <div class="shares-row-actions">
                  <Show when={links()[v.id]}>
                    {(url) => (
                      <button type="button" class="button button-sm" onClick={() => void copy(url())}>
                        Copy Link
                      </button>
                    )}
                  </Show>
                  <button type="button" class="button button-sm button-destructive" onClick={() => void off(v.id)} onBlur={() => armed() === v.id && setArmed(null)}>
                    {armed() === v.id ? "Turn Off Preview?" : "Turn Off"}
                  </button>
                </div>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={!address() || address()!.url}>
        <form class="stack previews-form" onSubmit={(e) => void create(e)}>
          <div class="public-links-row">
            <div class="field settings-field">
              <label class="field-label" for="preview-port">
                Port
              </label>
              <input
                id="preview-port"
                class="input input-mono"
                inputmode="numeric"
                autocomplete="off"
                placeholder="5173"
                value={port()}
                aria-invalid={formError() ? "true" : undefined}
                aria-describedby="preview-port-hint"
                onInput={(e) => {
                  setPort(e.currentTarget.value);
                  setFormError(null);
                }}
              />
            </div>
            <div class="field settings-field">
              <label class="field-label" for="preview-days">
                Expires
              </label>
              <select id="preview-days" class="select" onChange={(e) => setDays(Number(e.currentTarget.value))}>
                <For each={PREVIEW_EXPIRY_CHOICES}>
                  {(d) => (
                    <option value={d} selected={days() === d}>
                      {d === 1 ? "In 1 day" : `In ${d} days`}
                    </option>
                  )}
                </For>
              </select>
            </div>
          </div>
          <Show when={formError()}>
            {(e) => (
              <span class="field-error" id="preview-port-hint" role="alert">
                {e()}
              </span>
            )}
          </Show>
          <p class="field-hint">{previewWarning(typed())}</p>
          <div>
            <button type="submit" class="button button-sm button-primary" aria-disabled={busy() ? "true" : undefined}>
              New Preview
            </button>
          </div>
        </form>
      </Show>
    </section>
  );
}
