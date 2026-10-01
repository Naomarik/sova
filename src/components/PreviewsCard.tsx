import { createSignal, For, type JSX, Show } from "solid-js";
import { PREVIEW_PURPOSE_MAX } from "../../shared/preview-links";
import { getPreviews, mintPreview, turnOffPreview } from "../lib/api";
import { createPoll } from "../lib/poll";
import { previewRow, senderLine } from "../lib/preview-rows";
import {
  parsePort,
  PREVIEW_EXPIRY_CHOICES,
  previewGroups,
  previewWarning,
  recipientName,
  recipientOffConfirm,
  recipientOffDone,
  recipientOffTip,
  sentToLine,
  TURN_OFF_ALL_TIP,
  turnOffConfirm,
} from "../lib/previews";
import { resolveAppLink, sessionIndex, sessionIndexVersion } from "../lib/session-links";
import { copyText, toast } from "../lib/ui-state";
import { Banner } from "./ui";

const POLL_MS = 5_000;
const errText = (x: unknown) => (x instanceof Error ? x.message : String(x));

/** A `sova://s/<id>` link as a route in this tab (by id until the session list knows it); plain text without one. */
function SessionLink(props: { href: string | null; children: JSX.Element }) {
  const route = () => {
    sessionIndexVersion();
    const v = props.href ? resolveAppLink(props.href, sessionIndex()) : null;
    return v?.kind === "route" ? v.href : null;
  };
  return (
    <span>
      <Show when={route()} fallback={props.children}>
        {(href) => <a href={href()}>{props.children}</a>}
      </Show>
    </span>
  );
}

/**
 * A project's preview links (§mesh.public/preview-card): one row per active preview with what it is
 * for, its coding session, branch and what it serves, whether it serves now, who made it, its
 * expiry, Copy Link (the kept link, or one minted in this page) and Turn Off (every link sent from
 * it too); the people it was sent to on a Sent to line, each with a Turn Off of their own link;
 * then New Preview, which opens the form with the warning. Read every 5 seconds while the page shows.
 */
export function PreviewsCard(props: { orgId: string; projectId: string }) {
  const poll = createPoll(() => getPreviews(props.orgId, props.projectId), POLL_MS);
  /** Links minted in this page, by preview id: copyable even when the list keeps none. */
  const [links, setLinks] = createSignal<Record<string, string>>({});
  const [port, setPort] = createSignal("");
  const [purpose, setPurpose] = createSignal("");
  const [days, setDays] = createSignal<number>(PREVIEW_EXPIRY_CHOICES[0]);
  const [formError, setFormError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [armed, setArmed] = createSignal<string | null>(null);
  const [formOpen, setFormOpen] = createSignal(false);

  const list = () => previewGroups(poll.data()?.previews ?? []);
  const address = () => poll.data()?.address;
  /** The number typed, for the warning (named even when the port is refused). */
  const typed = () => (/^\d{1,5}$/.test(port().trim()) ? Number(port().trim()) : null);

  const copy = (url: string) => void copyText(url, "Link copied.");

  const create = async (e: Event) => {
    e.preventDefault();
    if (busy()) return;
    const p = parsePort(port());
    if ("error" in p) return setFormError(p.error);
    setBusy(true);
    setFormError(null);
    try {
      const why = purpose().trim();
      const made = await mintPreview({ orgId: props.orgId, projectId: props.projectId, port: p.port, days: days(), ...(why ? { purpose: why } : {}) });
      setLinks({ ...links(), [made.preview.id]: made.url });
      setPort("");
      setPurpose("");
      setFormOpen(false);
      if (made.linkWarning) toast(made.linkWarning);
      copy(made.url);
      poll.refetch();
    } catch (x) {
      setFormError(errText(x));
    } finally {
      setBusy(false);
    }
  };

  /** A second click turns it off; `done` is the toast. */
  const off = async (id: string, done = "Preview turned off.") => {
    if (armed() !== id) return setArmed(id);
    setArmed(null);
    try {
      await turnOffPreview(id);
      toast(done);
    } catch (x) {
      toast(`Couldn't turn it off. ${errText(x)}`);
    }
    poll.refetch();
  };

  const closeForm = () => {
    setFormOpen(false);
    setFormError(null);
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
            {(g) => {
              const v = g.preview;
              const row = () => previewRow(v, Date.now(), links()[v.id]);
              return (
                <li class="list-row previews-row">
                  <div class="list-main">
                    <p class="list-title previews-row-title">{row().title}</p>
                    <p class="list-meta previews-row-line">
                      <Show when={row().session}>
                        {(s) => <SessionLink href={s().href}>{s().title}</SessionLink>}
                      </Show>
                      <Show when={row().branch}>
                        {(b) => (
                          <span class="text-mono previews-row-branch" title={b()}>
                            {b()}
                          </span>
                        )}
                      </Show>
                      <span>{row().serves}</span>
                      <Show when={row().matched}>
                        <span>Matched by the app's folder</span>
                      </Show>
                      <span class={row().state.tone === "ok" ? "chip chip-success" : "chip chip-warn"}>
                        <span class="chip-dot" aria-hidden="true" />
                        {row().state.text}
                      </span>
                      <Show when={row().maker}>{(m) => <SessionLink href={m().href}>{m().text}</SessionLink>}</Show>
                      <Show when={sentToLine(v)}>{(sent) => <span>{sent()}</span>}</Show>
                      <span>{row().expires}</span>
                    </p>
                    <Show when={row().linkNote}>{(note) => <p class="list-meta">{note()}</p>}</Show>
                    <Show when={g.recipients.length > 0}>
                      <div class="list-meta previews-sent">
                        <span class="previews-sent-label">Sent to</span>
                        <ul class="previews-recipients">
                          <For each={g.recipients}>
                            {(r) => {
                              const name = () => recipientName(r);
                              return (
                                <li class="previews-recipient">
                                  <span class="previews-recipient-name" title={senderLine(r.createdBy) ?? undefined}>
                                    {name()}
                                  </span>
                                  <button
                                    type="button"
                                    class="button button-sm button-destructive previews-recipient-off"
                                    title={recipientOffTip(name())}
                                    onClick={() => void off(r.id, recipientOffDone(name()))}
                                    onBlur={() => armed() === r.id && setArmed(null)}
                                  >
                                    {armed() === r.id ? recipientOffConfirm(name()) : "Turn Off"}
                                  </button>
                                </li>
                              );
                            }}
                          </For>
                        </ul>
                      </div>
                    </Show>
                  </div>
                  <div class="shares-row-actions previews-row-actions">
                    <Show when={row().url}>
                      {(url) => (
                        <button type="button" class="button button-sm" onClick={() => copy(url())}>
                          Copy Link
                        </button>
                      )}
                    </Show>
                    <button
                      type="button"
                      class="button button-sm button-destructive"
                      title={v.siblingOf ? undefined : TURN_OFF_ALL_TIP}
                      onClick={() => void off(v.id)}
                      onBlur={() => armed() === v.id && setArmed(null)}
                    >
                      {armed() === v.id ? turnOffConfirm(g.recipients.length) : "Turn Off"}
                    </button>
                  </div>
                </li>
              );
            }}
          </For>
        </ul>
      </Show>
      <Show when={!address() || address()!.url}>
        <Show
          when={formOpen()}
          fallback={
            <div>
              <button type="button" class="button button-sm" aria-expanded="false" onClick={() => setFormOpen(true)}>
                New Preview
              </button>
            </div>
          }
        >
          <form id="preview-form" class="stack previews-form" onSubmit={(e) => void create(e)}>
            <div class="public-links-row">
              <div class="field settings-field">
                <label class="field-label" for="preview-port">
                  Port
                </label>
                <input
                  id="preview-port"
                  ref={(el) => queueMicrotask(() => el.focus())}
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
            <div class="field settings-field">
              <label class="field-label" for="preview-purpose">
                Purpose <span class="text-muted">(optional)</span>
              </label>
              <input
                id="preview-purpose"
                class="input"
                autocomplete="off"
                maxlength={PREVIEW_PURPOSE_MAX}
                placeholder="What it's for, like the new checkout"
                value={purpose()}
                onInput={(e) => setPurpose(e.currentTarget.value)}
              />
            </div>
            <Show when={formError()}>
              {(e) => (
                <span class="field-error" id="preview-port-hint" role="alert">
                  {e()}
                </span>
              )}
            </Show>
            <p class="field-hint">{previewWarning(typed())}</p>
            <div class="previews-form-actions">
              <button type="submit" class="button button-sm button-primary" aria-disabled={busy() ? "true" : undefined}>
                Create Preview
              </button>
              <button type="button" class="button button-sm button-ghost" onClick={closeForm}>
                Cancel
              </button>
            </div>
          </form>
        </Show>
      </Show>
    </section>
  );
}
