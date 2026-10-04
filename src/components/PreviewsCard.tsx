import { createSignal, For, type JSX, Show } from "solid-js";
import { PREVIEW_PURPOSE_MAX } from "../../shared/preview-links";
import { getProjectPreviews, mintPreview, runProjectVerb, turnOffPreview } from "../lib/api";
import { createPoll } from "../lib/poll";
import { previewRow, RECIPIENT_OFF_LABEL, recipientOffName, senderLine, turnOffLabel } from "../lib/preview-rows";
import {
  type PreviewGroup,
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
 * expiry, Copy Link and Open (the kept link, or one minted in this page) and Turn Off Preview
 * (every link sent from it too; on New Preview's line when it is the only row); the people it was
 * sent to on a Sent to line, each with a Turn Off Link of their own; then New Preview, which opens
 * the form with the warning. A running copy's link shows the copy's
 * state (Running, Starting, Stopped) and, stopped, Start: the operator's `up`, the only thing that
 * starts it (a visit never does). Read every 5 seconds while the page shows.
 */
export function PreviewsCard(props: { projectId: string }) {
  const poll = createPoll(() => getProjectPreviews(props.projectId), POLL_MS);
  /** Links minted in this page, by preview id: copyable even when the list keeps none. */
  const [links, setLinks] = createSignal<Record<string, string>>({});
  const [port, setPort] = createSignal("");
  const [purpose, setPurpose] = createSignal("");
  const [days, setDays] = createSignal<number>(PREVIEW_EXPIRY_CHOICES[0]);
  const [formError, setFormError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [armed, setArmed] = createSignal<string | null>(null);
  const [formOpen, setFormOpen] = createSignal(false);
  /** Copies this page is starting, by instance: Starting until `up` answers. */
  const [starting, setStarting] = createSignal<ReadonlySet<string>>(new Set());

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
      const made = await mintPreview({ projectId: props.projectId, port: p.port, days: days(), ...(why ? { purpose: why } : {}) });
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

  /** Start a stopped copy (`up` as the operator); a refusal says why. */
  const start = async (instance: string) => {
    if (starting().has(instance)) return;
    setStarting(new Set([...starting(), instance]));
    try {
      const r = await runProjectVerb(props.projectId, "up", { instance });
      toast(r.ok ? "Copy started." : `Couldn't start the copy. ${r.error?.message ?? ""}`.trim());
    } catch (x) {
      toast(`Couldn't start the copy. ${errText(x)}`);
    } finally {
      const next = new Set(starting());
      next.delete(instance);
      setStarting(next);
      poll.refetch();
    }
  };

  /** One preview and New Preview showing: its Turn Off moves to New Preview's line, at its right. */
  const solo = () => list().length === 1 && !formOpen() && (!address() || !!address()!.url);

  /** A row's own Turn Off: the preview and every link sent from it, or, for a sibling listed alone, that person's link. */
  const TurnOff = (p: { group: PreviewGroup }) => {
    const v = () => p.group.preview;
    const person = () => (v().siblingOf ? recipientName(v()) : null);
    return (
      <button
        type="button"
        class="button button-sm button-destructive previews-off"
        title={person() ? recipientOffTip(person()!) : TURN_OFF_ALL_TIP}
        onClick={() => void off(v().id, person() ? recipientOffDone(person()!) : undefined)}
        onBlur={() => armed() === v().id && setArmed(null)}
      >
        {armed() === v().id ? (person() ? recipientOffConfirm(person()!) : turnOffConfirm(p.group.recipients.length)) : person() ? recipientOffName(person()!) : turnOffLabel(p.group.recipients.length)}
      </button>
    );
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
              const row = () => previewRow(v.instance && starting().has(v.instance) ? { ...v, copy: { state: "starting", slot: v.copy?.slot ?? 0 } } : v, Date.now(), links()[v.id]);
              /** A tap unfolds the cut branch in place: a phone has no hover for its tooltip. */
              const [branchOpen, setBranchOpen] = createSignal(false);
              return (
                <li class="list-row previews-row">
                  <div class="list-main">
                    <p class="list-title previews-row-title">{row().title}</p>
                    <div class="list-meta previews-row-parts">
                      <Show when={row().session || row().branch}>
                        <p class="previews-row-line">
                          <Show when={row().session}>
                            {(s) => <SessionLink href={s().href}>{s().title}</SessionLink>}
                          </Show>
                          <Show when={row().branch}>
                            {(b) => (
                              <button type="button" class="text-mono previews-row-branch" classList={{ "previews-row-branch-open": branchOpen() }} title={b()} onClick={() => setBranchOpen(!branchOpen())}>
                                {b()}
                              </button>
                            )}
                          </Show>
                        </p>
                      </Show>
                      <p class="previews-row-line">
                        <span>{row().serves}</span>
                        <Show when={row().matched}>
                          <span>Matched by the app's folder</span>
                        </Show>
                        <span class={row().state.tone === "ok" ? "chip chip-success" : row().state.tone === "info" ? "chip chip-info" : "chip chip-warn"}>
                          <span class="chip-dot" aria-hidden="true" />
                          {row().state.text}
                        </span>
                      </p>
                      <p class="previews-row-line">
                        <Show when={row().maker}>{(m) => <SessionLink href={m().href}>{m().text}</SessionLink>}</Show>
                        <Show when={sentToLine(v)}>{(sent) => <span>{sent()}</span>}</Show>
                        <span>{row().expires}</span>
                      </p>
                    </div>
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
                                    aria-label={armed() === r.id ? undefined : recipientOffName(name())}
                                    onClick={() => void off(r.id, recipientOffDone(name()))}
                                    onBlur={() => armed() === r.id && setArmed(null)}
                                  >
                                    {armed() === r.id ? recipientOffConfirm(name()) : RECIPIENT_OFF_LABEL}
                                  </button>
                                </li>
                              );
                            }}
                          </For>
                        </ul>
                      </div>
                    </Show>
                  </div>
                  <Show when={row().start || row().url || !solo()}>
                    <div class="previews-row-actions">
                      <Show when={row().start}>
                        {(s) => (
                          <button type="button" class="button button-sm" title="Starts this copy. A visit to its link never starts it." onClick={() => void start(s().instance)}>
                            Start
                          </button>
                        )}
                      </Show>
                      <Show when={row().url}>
                        {(url) => (
                          <>
                            <button type="button" class="button button-sm" onClick={() => copy(url())}>
                              Copy Link
                            </button>
                            <a class="button button-sm" href={url()} target="_blank" rel="noopener noreferrer">
                              Open
                            </a>
                          </>
                        )}
                      </Show>
                      <Show when={!solo()}>
                        <TurnOff group={g} />
                      </Show>
                    </div>
                  </Show>
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
            <div class="previews-foot">
              <button type="button" class="button button-sm" aria-expanded="false" onClick={() => setFormOpen(true)}>
                New Preview
              </button>
              <Show when={solo()}>
                <TurnOff group={list()[0]!} />
              </Show>
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
