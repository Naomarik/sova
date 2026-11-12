import { createEffect, createResource, createSignal, For, onCleanup, Show } from "solid-js";
import { FRONT_LABELS, type PublicLinksInfo, type RoutedHost, type ShareFront, type VerifyResult } from "../../shared/public-links";
import { keyOf, type OpensAtKey, type OpensAtOption } from "../lib/opens-at";
import { agoTime, relativeTime } from "../lib/format";
import { fetchMeshResync } from "../lib/api";
import { meshPeers } from "../lib/mesh";
import { type MeshResync, resyncView } from "../lib/mesh-resync";
import {
  acceptPublicLinksInfo,
  deleteAccountToken,
  gatewayBehind,
  gatewayBehindText,
  gatewayResync,
  getPublicLinks,
  normalizeUrl,
  PIN_OF,
  publicLinksDraft as draft,
  publicLinksInfo,
  publicLinksSaved as saved,
  publicLinksSaveError,
  publicLinksSaving as saving,
  setPublicLinksDraft,
  setVisitorLoggingDraft,
  setVisitorLoggingSaved,
  getVisitorLogging,
  visitorLoggingDraft,
  visitorLoggingSaveError,
  visitorLoggingSaving,
  sourceLabel,
  stateChip,
  verifyPublicLinks,
  WEB_SERVER_FRONTS,
  type PublicLinksDraft,
} from "../lib/public-links";
import { copyText } from "../lib/ui-state";
import { MeshResyncSheet } from "./MeshResyncSheet";
import { OpensAtChoices, OpensAtSetup, TunnelPrompts, TunnelState } from "./OpensAt";
import { Banner, Chip, CopyButton } from "./ui";
import { Choice, NumberField, Select, TextField, Toggle } from "./form";
import { closeSettings } from "../lib/settings-nav";
import { INGRESS_PORT_RULE, PREVIEW_URL_RULE, PUBLIC_URL_RULE, SHARE_PORT_RULE } from "../../shared/public-links-limits";
import { sentence } from "./WorkerSlotRow";

/**
 * Settings → Public links (§mesh.public/panel): where the people you send a link open it, as the
 * sectioned list (OpensAt.tsx: Cloudflare Free or Account, Tailscale Funnel or Through a computer,
 * Your own web server, Off), then the chosen option's own fields: Free's tunnel and its Turn On and
 * Download; Account's address and token; a gateway's address, front, port, steps and Verify. Every field is staged and written by the dialog's Save Changes
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
  // The host's visitor switches (§mesh.public/visitor-log): their own small file and store.
  const [visitors] = createResource(getVisitorLogging);
  createEffect(() => {
    const v = visitors.error ? undefined : visitors();
    if (v) setVisitorLoggingSaved(v);
  });
  const visitorSwitches = [
    { key: "logVisitors", label: "Log visitors", hint: "Records each visitor's IP address, browser, language and pages opened on this host's links." },
    { key: "forwardIp", label: "Send the visitor's address to preview apps", hint: "Preview apps get X-Forwarded-For." },
  ] as const;
  /** What the server said last: the GET, or the answer to a save since. */
  const info = (): PublicLinksInfo | undefined => publicLinksInfo() ?? loaded();
  const pinned = () => info()?.pinnedByEnv ?? [];
  const pinOf = (field: keyof typeof PIN_OF) => (pinned().includes(PIN_OF[field]) ? PIN_OF[field] : null);

  const edit = (patch: Partial<PublicLinksDraft>) => {
    const d = draft();
    if (d) setPublicLinksDraft({ ...d, ...patch });
  };
  const off = () => !draft() || saving();

  const [verifying, setVerifying] = createSignal(false);
  /** The last Verify this panel ran, when it failed: the banner says why. Success reads from the server's verifiedAt. */
  const [failed, setFailed] = createSignal<(VerifyResult & { url: string }) | null>(null);
  /** The preview half of the last Verify (§mesh.public/preview-address), when the gateway has a preview address. */
  const [previewCheck, setPreviewCheck] = createSignal<VerifyResult["preview"] | null>(null);
  const verifiedAt = () => (info()?.share.state === "verified" ? info()?.file.verifiedAt : undefined);
  /** Verify checks the saved address: an unsaved edit has to be saved first. */
  const verifyBlocked = () => {
    const d = draft();
    const s = saved();
    if (d?.route === "account") {
      if (!s || s.route !== "account") return "Save the Account setting first.";
      return normalizeUrl(d.accountUrl) !== (s.account?.publicUrl ?? "") ? "Save the new address first." : null;
    }
    if (!d || !s || s.route !== "self" || d.route !== "self") return "Save the gateway setting first.";
    if (normalizeUrl(d.publicUrl) !== (s.gateway?.publicUrl ?? "") && !pinOf("publicUrl")) return "Save the new address first.";
    return null;
  };
  const verify = async () => {
    const url = info()?.share.publicUrl ?? (saved()?.route === "account" ? saved()?.account?.publicUrl : saved()?.gateway?.publicUrl) ?? "";
    setVerifying(true);
    setFailed(null);
    try {
      const r = await verifyPublicLinks();
      if (!r.ok) setFailed({ ...r, url });
      setPreviewCheck(r.preview ?? null);
    } catch (err) {
      setFailed({ ok: false, error: (err as Error).message, url });
    } finally {
      setVerifying(false);
    }
    // The state chip and the address row follow the server's answer.
    const next = await getPublicLinks().catch(() => null);
    if (next) acceptPublicLinksInfo(next);
  };

  /** The option the draft picks (null while an unreadable setting is untouched: nothing is picked). */
  const [touched, setTouched] = createSignal(false);
  const selected = (): OpensAtKey | null => {
    const d = draft();
    if (!d || (info()?.broken && !touched())) return null;
    return keyOf({ route: d.route === "via" ? { via: { nodeId: d.viaNodeId } } : d.route, gateway: { ...(saved()?.gateway ?? { publicUrl: "", sharePort: 0, acceptFrom: "all" }), front: d.front } });
  };
  /** The setup help an option not set up opened, under the list. */
  const [help, setHelp] = createSignal<OpensAtOption | null>(null);
  const pick = (o: OpensAtOption) => {
    setTouched(true);
    setHelp(o.state === "needs-setup" ? o : null);
    const d = draft();
    if (!d) return;
    const web = WEB_SERVER_FRONTS.includes(d.front) ? d.front : WEB_SERVER_FRONTS.includes(saved()?.gateway?.front ?? "funnel") ? saved()!.gateway!.front : "vhost";
    switch (o.key) {
      case "free":
        return edit({ route: "quick" });
      case "account":
        return edit({ route: "account" });
      case "off":
        return edit({ route: "off" });
      case "you-run-it":
        return edit({ route: "self", front: "cloudflared" });
      case "funnel":
        return edit({ route: "self", front: "funnel" });
      case "web-server":
        return edit({ route: "self", front: web });
      default:
        // Through: a computer that offers to carry links; none yet is only its help.
        if (o.key !== "through:") edit({ route: "via", viaNodeId: o.key.slice("through:".length) });
    }
  };
  /** The chosen gateway's name, for the advice line. */
  const viaName = () => {
    const id = draft()?.viaNodeId;
    return info()?.gateways?.find((g) => g.nodeId === id)?.peer ?? info()?.share.via ?? id ?? "";
  };
  /** The saved setting routes through the gateway the form shows: the share state is about it. */
  const viaSaved = () => {
    const r = saved()?.route;
    return typeof r === "object" && r.via.nodeId === draft()?.viaNodeId;
  };

  /** The accept list's rows: every peer, then a saved StableID with no peer any more (by its nodeId). */
  const acceptRows = () => {
    const rows = meshPeers().map((p) => ({ nodeId: p.nodeId, name: p.label || p.id }));
    const list = draft()?.acceptFrom;
    for (const id of list === "all" || !list ? [] : list) if (!rows.some((r) => r.nodeId === id)) rows.push({ nodeId: id, name: id });
    return rows;
  };
  const toggleAccept = (nodeId: string, on: boolean) => {
    const list = draft()?.acceptFrom;
    const cur = list === "all" || !list ? [] : list;
    edit({ acceptFrom: on ? [...cur.filter((x) => x !== nodeId), nodeId] : cur.filter((x) => x !== nodeId) });
  };

  /** The front's steps, when the server generated them for the draft's front. */
  const guide = () => info()?.front ?? null;
  /** The form's front differs from the saved setting the guide was generated for. */
  const guideStale = () => {
    const d = draft();
    const s = saved();
    return !d || !s || s.route !== "self" || !guide() || d.front !== s.gateway?.front;
  };

  /** Verify Address and its answers: the gateway's and Account's alike. */
  const VerifyRow = () => (
    <>
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
          <Show when={!verifyBlocked() && previewCheck()}>
            {(p) => (
              <Show
                when={p().ok}
                fallback={
                  <Banner
                    tone="warn"
                    title="Preview hosts don't reach this gateway yet."
                    body={`${sentence(p().error ?? (p().status ? `It answered ${p().status}` : "No answer"))} Check the wildcard DNS record and the front, then verify again.`}
                  />
                }
              >
                <span class="field-hint" role="status">
                  Preview hosts reach this gateway too.
                </span>
              </Show>
            )}
          </Show>
          <Show when={!verifyBlocked() && failed()}>
            {(v) => (
              <Banner
                tone="error"
                title={`Couldn't reach ${v().url}.`}
                body={`${sentence(v().error ?? (v().status ? `It answered ${v().status}` : "No answer"))} Links still open on your devices. Check the front, then verify again.`}
              />
            )}
          </Show>
    </>
  );

  return (
    <section class="stack public-links-settings" aria-labelledby="settings-public-links-title">
      <div class="settings-type-head">
        <h3 class="settings-type-title" id="settings-public-links-title">
          Public links
        </h3>
        <Show when={info()}>{(i) => <Chip tone={stateChip(i().share, i()).tone}>{stateChip(i().share, i()).word}</Chip>}</Show>
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
      <Show when={info()?.share.listener}>
        {(l) => (
          <Banner
            tone="error"
            title="The share port isn't open."
            body={`${l().reason} Links from this host can't be opened from outside until it is. Fix it, then save a different port or restart Sova.`}
          />
        )}
      </Show>

      <Show when={info()?.broken}>
        <TunnelPrompts info={info()!} />
      </Show>
      <fieldset class="field public-links-route">
        <legend class="field-label">Where links open</legend>
        <Show when={info()}>{(i) => <OpensAtChoices info={i()} selected={selected()} withOff disabled={off()} idPrefix="settings" onPick={pick} />}</Show>
        <Show when={help()}>{(o) => <OpensAtSetup kind={o().setup ?? "through"} inSettings onOpened={closeSettings} />}</Show>
      </fieldset>

      <fieldset class="field public-links-route">
        <legend class="field-label">Visitor logging</legend>
        <For each={visitorSwitches}>
          {(s) => (
            <Toggle
              class="public-links-choice"
              label={<span class="public-links-choice-main"><span class="public-links-choice-name">{s.label}</span><span class="public-links-choice-meta">{s.hint}</span></span>}
              checked={visitorLoggingDraft()?.[s.key] ?? false}
              disabled={!visitorLoggingDraft() || visitorLoggingSaving()}
              onChange={(v) => {
                const d = visitorLoggingDraft();
                if (d) setVisitorLoggingDraft({ ...d, [s.key]: v });
              }}
            />
          )}
        </For>
        <Show when={visitorLoggingSaveError()}>
          {(e) => <Banner tone="error" title="Couldn't save visitor logging." body={`${sentence(e().message)} Your saved setting is unchanged.`} />}
        </Show>
      </fieldset>

      <Show when={draft()?.route === "quick" && saved()?.route === "quick" && info()}>
        {(i) => (
          <div class="stack public-links-gateway">
            <TunnelState info={i()} />
            <TunnelPrompts info={i()} />
          </div>
        )}
      </Show>

      <Show when={draft()?.route === "account"}>
        <div class="stack public-links-gateway">
          <TextField
            class="settings-field public-links-url"
            inputClass="input-mono"
            id="public-links-account-url"
            label="Public address"
            rule={PUBLIC_URL_RULE}
            autocomplete="off"
            spellcheck={false}
            inputmode="url"
            placeholder="https://share.example.com"
            value={draft()?.accountUrl ?? ""}
            disabled={off()}
            onInput={(raw) => edit({ accountUrl: raw })}
          />
          <TextField
            class="settings-field public-links-url"
            inputClass="input-mono"
            id="public-links-account-preview"
            label="Preview address (optional)"
            rule={PREVIEW_URL_RULE}
            autocomplete="off"
            spellcheck={false}
            inputmode="url"
            placeholder="https://*.example.com"
            value={draft()?.accountPreviewUrl ?? ""}
            disabled={off()}
            onInput={(raw) => edit({ accountPreviewUrl: raw })}
          />
          <AccountToken disabled={off()} hasToken={!!info()?.account?.hasToken} value={draft()?.accountToken ?? ""} onInput={(raw) => edit({ accountToken: raw })} />
          <Show when={saved()?.route === "account" && info()}>{(i) => <TunnelState info={i()} />}</Show>
          <Show when={saved()?.route === "account" && info()}>{(i) => <TunnelPrompts info={i()} />}</Show>
          <VerifyRow />
        </div>
      </Show>

      <Show when={draft()?.route === "self"}>
        <div class="stack public-links-gateway">
          <TextField
            class="settings-field public-links-url"
            inputClass="input-mono"
            id="public-links-url"
            label="Public address"
            hint={pinOf("publicUrl") && `Set by environment (${pinOf("publicUrl")}). Change it there, then restart Sova.`}
            rule={pinOf("publicUrl") ? undefined : PUBLIC_URL_RULE}
            autocomplete="off"
            spellcheck={false}
            inputmode="url"
            placeholder="https://share.example.com"
            value={pinOf("publicUrl") ? (info()?.share.publicUrl ?? "") : (draft()?.publicUrl ?? "")}
            disabled={off()}
            readOnly={!!pinOf("publicUrl")}
            onInput={(raw) => edit({ publicUrl: raw })}
          />
          <TextField
            class="settings-field public-links-url"
            inputClass="input-mono"
            id="public-links-preview"
            label="Preview address"
            hint={
              pinOf("previewUrl") ? `Set by environment (${pinOf("previewUrl")}). Change it there, then restart Sova.`
                : "Optional. Preview links open each app at its own name under this domain. It needs a wildcard DNS record and certificate; the steps below say how."
            }
            rule={pinOf("previewUrl") ? undefined : PREVIEW_URL_RULE}
            autocomplete="off"
            spellcheck={false}
            inputmode="url"
            placeholder="https://*.example.com"
            value={pinOf("previewUrl") ? (info()?.preview?.url ?? "") : (draft()?.previewUrl ?? "")}
            disabled={off()}
            readOnly={!!pinOf("previewUrl")}
            onInput={(raw) => edit({ previewUrl: raw })}
          />

          <div class="public-links-row">
            <Show when={WEB_SERVER_FRONTS.includes(draft()?.front ?? "vhost")}>
              <Select
                class="settings-field"
                id="public-links-front"
                label="Front"
                value={draft()?.front ?? ""}
                options={WEB_SERVER_FRONTS.map((f) => ({ value: f, label: FRONT_LABELS[f] }))}
                disabled={off()}
                onChange={(v) => edit({ front: v as ShareFront })}
              />
            </Show>
            <NumberField
              class="settings-field public-links-port"
              inputClass="input-mono"
              id="public-links-port"
              label="Local port"
              hint={pinOf("sharePort") && `Set by environment (${pinOf("sharePort")}). Change it there, then restart Sova.`}
              rule={pinOf("sharePort") ? undefined : SHARE_PORT_RULE}
              value={draft()?.sharePort ?? ""}
              disabled={off()}
              readOnly={!!pinOf("sharePort")}
              onInput={(raw) => edit({ sharePort: raw })}
            />
          </div>

          <fieldset class="field public-links-accept">
            <legend class="field-label">Accept links from</legend>
            <Choice
              class="public-links-accept-modes public-links-choices"
              label="Accept links from"
              value={Array.isArray(draft()?.acceptFrom) ? "some" : "all"}
              options={[{ value: "all", label: <span class="public-links-choice-name">All hosts</span> }, { value: "some", label: <span class="public-links-choice-name">These hosts</span> }]}
              disabled={off()}
              onChange={(v) => edit({ acceptFrom: v === "all" ? "all" : [] })}
            />
            <Show when={Array.isArray(draft()?.acceptFrom)}>
              <ul class="public-links-accept-list">
                <For each={acceptRows()}>
                  {(row) => (
                    <li>
                      <Toggle
                        class="public-links-check"
                        label={<span class="public-links-choice-name">{row.name}</span>}
                        checked={(draft()?.acceptFrom as string[]).includes(row.nodeId)}
                        disabled={off()}
                        onChange={(v) => toggleAccept(row.nodeId, v)}
                      />
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </fieldset>

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

          <VerifyRow />

          <section class="public-links-routed" aria-labelledby="public-links-routed-title">
            <h4 class="public-links-front-title" id="public-links-routed-title">
              Hosts sending links here
            </h4>
            <Show when={(info()?.routed ?? []).length > 0} fallback={<p class="settings-intro">No other host sends its links here yet.</p>}>
              <ul class="list public-links-routed-list">
                <For each={info()?.routed ?? []}>{(h) => <RoutedRow host={h} />}</For>
              </ul>
            </Show>
          </section>
        </div>
      </Show>

      <Show when={draft()?.route === "via"}>
        <div class="stack public-links-gateway">
          <p class="settings-intro">Links open only while {viaName()} is on. Keep a client's organization on an always-on host.</p>
          <NumberField
            class="settings-field public-links-port"
            inputClass="input-mono"
            id="public-links-ingress"
            label="Ingress port"
            rule={INGRESS_PORT_RULE}
            value={draft()?.ingressPort ?? ""}
            disabled={off()}
            onInput={(raw) => edit({ ingressPort: raw })}
          />
          <Show when={viaSaved() && info()?.share}>
            {(sh) => (
              <>
                <Show when={(sh().warningCode === "unreachable" || sh().warningCode === "not-accepted") && sh().warning}>
                  {(w) => <Banner tone="warn" title={w()} />}
                </Show>
                <Show when={sh().warningCode === "sleeps" && sh().warning}>{(w) => <p class="field-hint">{w()}</p>}</Show>
                <Show when={gatewayBehind(info()) && sh().via}>{(id) => <GatewayBehind peerId={id()} name={viaName()} />}</Show>
              </>
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

/** One host sending its links here: its name, how many, up or down (or not accepted), and its last push. Read-only. */
function RoutedRow(props: { host: RoutedHost }) {
  const h = () => props.host;
  return (
    <li class="list-row public-links-routed-row">
      <span class="list-main">
        <span class="list-title">{h().peer ?? h().nodeId}</span>
        <span class="list-meta">
          {h().links === 1 ? "1 link" : `${h().links} links`} · {h().lastPushAt === null ? "Never pushed" : `Last push ${relativeTime(h().lastPushAt!)}`}
        </span>
      </span>
      <Show when={h().accepted} fallback={<Chip tone="warn">Not accepted</Chip>}>
        <Chip tone={h().up ? "success" : undefined}>{h().up ? "Up" : "Down"}</Chip>
      </Show>
    </li>
  );
}

/**
 * The via gateway runs an older share protocol (§mesh.public/panel): a warn banner with the host
 * menu's Resync for that peer (§mesh.peers/resync), its confirm sheet, and its reason when it can't.
 * /api/mesh/resync is read once when the banner shows; no answer, or no word about the peer: no button.
 */
function GatewayBehind(props: { peerId: string; name: string }) {
  const [resync, setResync] = createSignal<MeshResync | null>(null);
  const [sheet, setSheet] = createSignal(false);
  let closed = false;
  onCleanup(() => (closed = true));
  fetchMeshResync().then(
    (r) => !closed && setResync(r),
    () => {
      // no button: the banner still says what it means
    },
  );
  const button = () => {
    const r = resync();
    return r ? gatewayResync(resyncView(r.hosts.find((h) => h.id === props.peerId), r.self)) : null;
  };
  let trigger: HTMLButtonElement | undefined;
  const text = () => gatewayBehindText(props.name);
  return (
    <>
      <Banner
        tone="warn"
        title={text().title}
        body={text().body}
        action={
          <Show when={button()}>
            {(b) => (
              <button
                ref={trigger}
                type="button"
                class="button button-sm"
                aria-label={`Resync ${props.name}`}
                aria-disabled={b().reason ? "true" : undefined}
                title={b().reason ?? `Bring ${props.name} up to this host's build`}
                onClick={() => !b().reason && setSheet(true)}
              >
                Resync
              </button>
            )}
          </Show>
        }
      />
      <Show when={button()?.reason}>{(why) => <p class="field-hint">{why()}</p>}</Show>
      <Show when={sheet() ? resync() : null}>
        {(r) => (
          <MeshResyncSheet
            hostId={props.peerId}
            info={r()}
            onChanged={setResync}
            onClose={() => {
              setSheet(false);
              trigger?.focus();
            }}
          />
        )}
      </Show>
    </>
  );
}

/**
 * Cloudflare Account's connector token (§mesh.tunnel/account): pasted, staged like the panel's other
 * fields and written by Save Changes, never shown back. Saved: "Token saved." and Remove Token.
 */
function AccountToken(props: { hasToken: boolean; value: string; disabled: boolean; onInput(raw: string): void }) {
  const [removing, setRemoving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const remove = async () => {
    setRemoving(true);
    setError(null);
    try {
      await deleteAccountToken();
      const next = await getPublicLinks().catch(() => null);
      if (next) acceptPublicLinksInfo(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRemoving(false);
    }
  };
  return (
    <div class="stack-2">
      <TextField
        class="settings-field public-links-url"
        inputClass="input-mono"
        id="public-links-account-token"
        type="password"
        label="Connector token"
        hint={props.hasToken && !props.value ? "Token saved." : undefined}
        autocomplete="off"
        spellcheck={false}
        placeholder="Paste the token from the Cloudflare dashboard"
        value={props.value}
        disabled={props.disabled}
        onInput={props.onInput}
      />
      <Show when={props.hasToken}>
        <div class="cluster">
          <button type="button" class="button button-sm button-destructive" disabled={props.disabled || removing()} onClick={() => void remove()}>
            {removing() ? "Removing…" : "Remove Token"}
          </button>
        </div>
      </Show>
      <Show when={error()}>{(e) => <span class="field-error">{sentence(e())} The token is unchanged.</span>}</Show>
    </div>
  );
}
