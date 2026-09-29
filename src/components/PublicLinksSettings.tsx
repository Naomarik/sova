import { createEffect, createResource, createSignal, For, Show } from "solid-js";
import { FRONT_LABELS, type PublicLinksInfo, type ShareFront, type VerifyResult } from "../../shared/public-links";
import { agoTime } from "../lib/format";
import {
  acceptPublicLinksInfo,
  draftIssue,
  FRONTS,
  getPublicLinks,
  normalizeUrl,
  PIN_OF,
  publicLinksDraft as draft,
  publicLinksInfo,
  publicLinksSaved as saved,
  publicLinksSaveError,
  publicLinksSaving as saving,
  setPublicLinksDraft,
  sourceLabel,
  stateChip,
  verifyPublicLinks,
  type PublicLinksDraft,
  type RouteChoice,
} from "../lib/public-links";
import { copyText } from "../lib/ui-state";
import { Banner, Chip, CopyButton } from "./ui";
import { sentence } from "./WorkerSlotRow";

/** The route choices this build offers; "Through {gateway}" arrives with the routed half (M6b). */
const ROUTES: { id: RouteChoice; label: string; hint: string }[] = [
  { id: "off", label: "Off", hint: "Links work only on your own devices." },
  { id: "self", label: "This host is the gateway", hint: "This host serves every public link, including those from hosts that go through it." },
];

/**
 * Settings → Public links (§mesh.public/setting): where the people you send a link open it. Off, or
 * this host is the gateway: its public address, the front that carries it, the local port, the
 * front's one-time step, and Verify. Every field is staged and written by the dialog's Save Changes
 * (lib/public-links.ts); a field an environment variable decides is shown, not editable. Works with
 * the mesh off, so it is its own tab.
 */
export function PublicLinksSettingsSection() {
  const [stored] = createResource(getPublicLinks);
  const loaded = () => (stored.error ? undefined : stored());
  createEffect(() => {
    const i = loaded();
    if (i) acceptPublicLinksInfo(i);
  });
  /** What the server said last: the GET, or the answer to a save since. */
  const info = (): PublicLinksInfo | undefined => publicLinksInfo() ?? loaded();
  const pinned = () => info()?.pinnedByEnv ?? [];
  const pinOf = (field: keyof typeof PIN_OF) => (pinned().includes(PIN_OF[field]) ? PIN_OF[field] : null);

  const edit = (patch: Partial<PublicLinksDraft>) => {
    const d = draft();
    if (d) setPublicLinksDraft({ ...d, ...patch });
  };
  const issue = () => {
    const d = draft();
    return d ? draftIssue(d, pinned()) : null;
  };
  const off = () => !draft() || saving();

  const [verifying, setVerifying] = createSignal(false);
  /** The last Verify this panel ran, when it failed: the banner says why. Success reads from the server's verifiedAt. */
  const [failed, setFailed] = createSignal<(VerifyResult & { url: string }) | null>(null);
  const verifiedAt = () => (info()?.share.state === "verified" ? info()?.file.verifiedAt : undefined);
  /** Verify checks the saved address: an unsaved edit has to be saved first. */
  const verifyBlocked = () => {
    const d = draft();
    const s = saved();
    if (!d || !s || s.route !== "self" || d.route !== "self") return "Save the gateway setting first.";
    if (normalizeUrl(d.publicUrl) !== (s.gateway?.publicUrl ?? "") && !pinOf("publicUrl")) return "Save the new address first.";
    return null;
  };
  const verify = async () => {
    const url = info()?.share.publicUrl ?? saved()?.gateway?.publicUrl ?? "";
    setVerifying(true);
    setFailed(null);
    try {
      const r = await verifyPublicLinks();
      if (!r.ok) setFailed({ ...r, url });
    } catch (err) {
      setFailed({ ok: false, error: (err as Error).message, url });
    } finally {
      setVerifying(false);
    }
    // The state chip and the address row follow the server's answer.
    const next = await getPublicLinks().catch(() => null);
    if (next) acceptPublicLinksInfo(next);
  };

  /** The front's steps, when the server generated them for the draft's front. */
  const guide = () => info()?.front ?? null;
  /** The form's front differs from the saved setting the guide was generated for. */
  const guideStale = () => {
    const d = draft();
    const s = saved();
    return !d || !s || s.route !== "self" || !guide() || d.front !== s.gateway?.front;
  };

  return (
    <section class="stack public-links-settings" aria-labelledby="settings-public-links-title">
      <div class="settings-type-head">
        <h3 class="settings-type-title" id="settings-public-links-title">
          Public links
        </h3>
        <Show when={info()}>{(i) => <Chip tone={stateChip(i().share).tone}>{stateChip(i().share).word}</Chip>}</Show>
      </div>
      <p class="settings-intro">People you send a link to open it at this address.</p>
      <Show when={stored.error}>
        {(err) => <Banner tone="error" title="Couldn't read the public links setting." body={`Nothing was changed. ${sentence((err() as Error).message)}`} />}
      </Show>

      <Show when={info()}>
        {(i) => (
          <dl class="public-links-address">
            <dt>Address</dt>
            <dd>
              <Show when={i().share.publicUrl} fallback={<span class="text-muted">None</span>}>
                {(u) => <code class="text-mono public-links-url">{u()}</code>}
              </Show>
              <Show when={i().share.publicUrl}>
                <span class="public-links-source">{sourceLabel(i().share, i().pinnedByEnv)}</span>
              </Show>
            </dd>
          </dl>
        )}
      </Show>

      <fieldset class="field public-links-route">
        <legend class="field-label">Where links open</legend>
        <For each={ROUTES}>
          {(r) => (
            <label class="toggle public-links-choice">
              <input type="radio" name="public-links-route" value={r.id} checked={draft()?.route === r.id} disabled={off()} onChange={() => edit({ route: r.id })} />
              <span class="toggle-box" aria-hidden="true" />
              <span class="public-links-choice-main">
                <span class="public-links-choice-name">{r.label}</span>
                <span class="public-links-choice-meta">{r.hint}</span>
              </span>
            </label>
          )}
        </For>
      </fieldset>

      <Show when={draft()?.route === "self"}>
        <div class="stack public-links-gateway">
          <div class="field settings-field public-links-url">
            <label class="field-label" for="public-links-url">
              Public address
            </label>
            <input
              id="public-links-url"
              class="input input-mono"
              autocomplete="off"
              spellcheck={false}
              inputmode="url"
              placeholder="https://share.example.com"
              value={pinOf("publicUrl") ? (info()?.share.publicUrl ?? "") : (draft()?.publicUrl ?? "")}
              disabled={off()}
              readOnly={!!pinOf("publicUrl")}
              aria-invalid={issue()?.field === "publicUrl" ? "true" : undefined}
              aria-describedby="public-links-url-hint"
              onInput={(e) => edit({ publicUrl: e.currentTarget.value })}
            />
            <Show
              when={pinOf("publicUrl")}
              fallback={
                <Show when={issue()?.field === "publicUrl"}>
                  <span class="field-error" id="public-links-url-hint">
                    {issue()!.text}
                  </span>
                </Show>
              }
            >
              {(v) => (
                <span class="field-hint" id="public-links-url-hint">
                  Set by environment ({v()}). Change it there, then restart Sova.
                </span>
              )}
            </Show>
          </div>

          <div class="public-links-row">
            <div class="field settings-field">
              <label class="field-label" for="public-links-front">
                Front
              </label>
              <select id="public-links-front" class="select" disabled={off()} onChange={(e) => edit({ front: e.currentTarget.value as ShareFront })}>
                <For each={FRONTS}>
                  {(f) => (
                    <option value={f} selected={draft()?.front === f}>
                      {FRONT_LABELS[f]}
                    </option>
                  )}
                </For>
              </select>
            </div>
            <div class="field settings-field public-links-port">
              <label class="field-label" for="public-links-port">
                Local port
              </label>
              <input
                id="public-links-port"
                class="input input-mono"
                type="number"
                min="1"
                max="65535"
                autocomplete="off"
                value={draft()?.sharePort ?? ""}
                disabled={off()}
                readOnly={!!pinOf("sharePort")}
                aria-invalid={issue()?.field === "sharePort" ? "true" : undefined}
                aria-describedby="public-links-port-hint"
                onInput={(e) => edit({ sharePort: e.currentTarget.value })}
              />
              <Show
                when={pinOf("sharePort")}
                fallback={
                  <Show when={issue()?.field === "sharePort"}>
                    <span class="field-error" id="public-links-port-hint">
                      {issue()!.text}
                    </span>
                  </Show>
                }
              >
                {(v) => (
                  <span class="field-hint" id="public-links-port-hint">
                    Set by environment ({v()}). Change it there, then restart Sova.
                  </span>
                )}
              </Show>
            </div>
          </div>

          <Show when={guideStale()}>
            <section class="public-links-front" aria-labelledby="public-links-front-title">
              <h4 class="public-links-front-title" id="public-links-front-title">
                Set up the front once
              </h4>
              <p class="settings-intro">Save Changes to see the step for this setting.</p>
            </section>
          </Show>
          <Show when={!guideStale() && guide()}>
            {(g) => (
              <section class="public-links-front" aria-labelledby="public-links-front-title">
                <h4 class="public-links-front-title" id="public-links-front-title">
                  Set up the front once
                </h4>
                <p class="settings-intro">
                  Anything that serves {hostOf(saved()?.gateway?.publicUrl ?? "")} and forwards to 127.0.0.1:{saved()?.gateway?.sharePort} works. Sova doesn't
                  run this step for you.
                </p>
                <ol class="public-links-steps">
                  <For each={g().steps}>
                    {(s) => (
                      <li class="public-links-step">
                        <div class="public-links-step-head">
                          <span class="public-links-step-label">{s.label}</span>
                          <Show when={s.root}>
                            <Chip tone="warn">Needs root</Chip>
                          </Show>
                          <CopyButton label="Copy Step" text={() => s.text} onCopy={(t) => copyText(t, "Copied the step.")} />
                        </div>
                        <pre class="public-links-step-text">{s.text}</pre>
                      </li>
                    )}
                  </For>
                </ol>
                <For each={g().notes ?? []}>{(n) => <p class="settings-intro">{n}</p>}</For>
              </section>
            )}
          </Show>

          <div class="public-links-verify">
            <button
              type="button"
              class="button button-sm"
              disabled={verifying() || !!verifyBlocked()}
              title={verifyBlocked() ?? undefined}
              onClick={() => void verify()}
            >
              {verifying() ? "Verifying…" : "Verify Address"}
            </button>
            <Show when={verifyBlocked()}>{(why) => <span class="field-hint">{why()}</span>}</Show>
            <Show when={!verifyBlocked() && !failed() && verifiedAt()}>
              {(at) => (
                <span class="field-hint" role="status">
                  Verified {agoTime(at())}. {info()?.share.publicUrl} reaches this gateway.
                </span>
              )}
            </Show>
          </div>
          <Show when={!verifyBlocked() && failed()}>
            {(v) => (
              <Banner
                tone="error"
                title={`Couldn't reach ${v().url}.`}
                body={`${sentence(v().error ?? (v().status ? `It answered ${v().status}` : "No answer"))} Links still open on your devices. Check the front, then verify again.`}
              />
            )}
          </Show>
        </div>
      </Show>

      <Show when={publicLinksSaveError()}>
        {(e) => <Banner tone="error" title="Couldn't save the public links setting." body={`${sentence(e().message)} Your saved setting is unchanged.`} />}
      </Show>
    </section>
  );
}

/** "https://share.example.com" as the step line names it. */
const hostOf = (url: string): string => url || "your public address";
