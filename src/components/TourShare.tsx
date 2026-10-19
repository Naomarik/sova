import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { TourPresentation } from "../../shared/tour";
import { tourPreviewItems } from "../lib/tour-state";
import { tourPreviewSummary, tourPreviewText } from "../lib/tour-share-preview";
import { Icon } from "./ui";
import "./TourViewer.css";

export interface TourSharePreview { previewId: string; manifest: TourPresentation; expiresAt: string }
export interface TourShareLink { id: string; url: string; expiresAt: string; editionId: string }
export interface TourHandoffDestination { sessionId: string; orgId: string; orgName: string; publicTitle: string; holder: string | null }
export interface TourBinding extends Omit<TourHandoffDestination, "sessionId"> { handle: string; destinationSessionId: string; title: string; summary: string; steps: number }
export interface TourShareProps {
  loadPreview(): Promise<TourSharePreview>;
  assetUrl(file: string): string;
  createLink(previewId: string, expiresAt: string): Promise<TourShareLink>;
  loadDestinations?(): Promise<TourHandoffDestination[]>;
  loadBindingPreview?(destinationSessionId: string): Promise<TourSharePreview>;
  bind?(previewId: string, destinationSessionId: string): Promise<unknown>;
  onBound?(): void;
  onClose(): void;
}
const message = (e: unknown) => e instanceof Error ? e.message : "The request failed. Try again.";

/** Approval is tied to the exact preview; every picture and reference has its own review control. */
export function TourShare(props: TourShareProps) {
  let dialog!: HTMLDialogElement;
  let close!: HTMLButtonElement;
  const [preview, setPreview] = createSignal<TourSharePreview>();
  const [expiry, setExpiry] = createSignal(7 * 86400);
  const [reviewed, setReviewed] = createSignal(new Set<string>());
  const [loaded, setLoaded] = createSignal(new Set<string>());
  const [failed, setFailed] = createSignal(new Set<string>());
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [link, setLink] = createSignal<TourShareLink>();
  const [copied, setCopied] = createSignal(false);
  const [destination, setDestination] = createSignal("");
  const [destinations, setDestinations] = createSignal<TourHandoffDestination[]>([]);
  const [bound, setBound] = createSignal(false);
  const handoff = () => destinations().find(d => d.sessionId === destination());
  const orgs = () => [...new Map(destinations().map(d => [d.orgId, { id: d.orgId, name: d.orgName }])).values()];
  let disposed = false;
  let loadSequence = 0;
  const items = () => preview() ? tourPreviewItems(preview()!.manifest) : [];
  const ready = () => !!preview() && items().length > 0 && items().every(p => reviewed().has(p.key) && (!p.capture || loaded().has(p.key) && !failed().has(p.key)));
  const load = async () => {
    const seq = ++loadSequence;
    setBusy(true); setError(""); setPreview(undefined); setLink(undefined); setBound(false); setCopied(false); setReviewed(new Set<string>()); setLoaded(new Set<string>()); setFailed(new Set<string>());
    try {
      const value = destination() ? await props.loadBindingPreview!(destination()) : await props.loadPreview();
      if (!disposed && seq === loadSequence) setPreview(value);
    }
    catch (e) { if (!disposed && seq === loadSequence) setError(message(e)); }
    finally { if (!disposed && seq === loadSequence) setBusy(false); }
  };
  onMount(() => {
    dialog.showModal(); close.focus(); void load();
    if (props.loadDestinations) void props.loadDestinations().then(rows => { if (!disposed) setDestinations(rows); }, e => { if (!disposed) setError(message(e)); });
  });
  onCleanup(() => { disposed = true; if (dialog.open) dialog.close(); });
  const create = async () => {
    if (!ready() || busy()) return;
    setBusy(true); setError("");
    try {
      if (destination()) {
        await props.bind!(preview()!.previewId, destination());
        if (!disposed) { setBound(true); props.onBound?.(); }
      } else {
        const result = await props.createLink(preview()!.previewId, new Date(Date.now() + expiry() * 1000).toISOString());
        if (!disposed) setLink(result);
      }
    }
    catch (e) { if (!disposed) setError(message(e)); }
    finally { if (!disposed) setBusy(false); }
  };
  return <dialog ref={dialog} class="tour-share" aria-label="Share tour" onClose={props.onClose}>
    <header class="tour-share-head"><div><span class="text-eyebrow text-muted">Review before sharing</span><h2>Share tour</h2></div><button ref={close} type="button" class="button button-icon button-ghost" aria-label="Close Share" onClick={() => dialog.close()}><Icon name="close" /></button></header>
    <div class="tour-share-body">
      <p>{destination() ? "Everyone allowed to read this part of the hand-off can read this edition. It gives no access to the recorded app or its accounts." : "Anyone with the link can read this edition until it expires. It gives no access to the recorded app or its accounts."}</p>
      <Show when={props.loadDestinations && props.loadBindingPreview && props.bind}><label class="field"><span class="field-label">Share destination</span><select class="select" value={destination()} disabled={busy()} onChange={e => { setDestination(e.currentTarget.value); void load(); }}><option value="">Create a link</option><For each={orgs()}>{org => <optgroup label={org.name}><For each={destinations().filter(d => d.orgId === org.id)}>{d => <option value={d.sessionId}>{d.publicTitle} · {d.holder ? `With ${d.holder}` : "With you"}</option>}</For></optgroup>}</For></select><span class="field-hint">Send to a hand-off, or create an expiring link.</span><Show when={!destinations().length}><span class="field-hint">No open hand-off conversations are available for this tour.</span></Show></label></Show>
      <Show when={handoff()}>{d => <p>Send to <b>{d().publicTitle}</b> · {d().orgName} · {d().holder ? `With ${d().holder}` : "With you"}</p>}</Show>
      <Show when={error()}><p class="field-error" role="alert">{error()}</p><Show when={!preview()}><button type="button" class="button" disabled={busy()} onClick={() => void load()}>Retry Preview</button></Show></Show>
      <Show when={busy() && !preview()}><p role="status">Loading every picture and its text…</p></Show>
      <Show when={preview()}>{p => <>
        <h3>{p().manifest.title}</h3><p>{p().manifest.summary}</p>
        <p class="text-caption text-muted">{tourPreviewSummary(p().manifest, items().filter(i => i.capture).length)}</p>
        <Show when={p().manifest.chapters.length}><p class="text-caption">Chapters: {p().manifest.chapters.map(c => c.title).join(" · ")}</p></Show>
        <Show when={!destination()}><div class="tour-share-settings"><label class="field"><span class="field-label">Link expires after</span><select class="select" value={expiry()} disabled={!!link() || busy()} onChange={e => setExpiry(Number(e.currentTarget.value))}><option value={86400}>24 hours</option><option value={7 * 86400}>7 days</option><option value={30 * 86400}>30 days</option></select></label><p class="text-caption text-muted">A re-recorded tour needs a new reviewed link.</p></div></Show>
        <div class="tour-share-grid"><For each={items()}>{item => <figure>
          <Show when={item.capture} fallback={<div class="tour-share-reference"><span class="chip">{item.view.kind === "reference" ? "Explained in words · not pictured" : `${item.size} view unavailable`}</span><p>{item.view.reference ?? item.view.unavailableReason}</p></div>}>{capture => <img src={props.assetUrl(capture().image)} alt={`Step ${item.step.n}: ${item.view.title}, ${item.size}`} loading="lazy" onLoad={() => setLoaded(s => new Set([...s, item.key]))} onError={() => setFailed(s => new Set([...s, item.key]))} />}</Show>
          <figcaption>{(() => { const t = tourPreviewText(p().manifest, item); return <><Show when={t.chapter}><span class="text-eyebrow text-muted">{t.chapter}</span></Show><b>{t.step}</b><span>{t.view}</span><p>{t.summary}</p><Show when={t.note}><p>{t.note}</p></Show><Show when={t.callouts.length}><ol><For each={t.callouts}>{label => <li>{label}</li>}</For></ol></Show></>; })()}
            <Show when={failed().has(item.key)}><p class="field-error">Picture unavailable. Reload the preview before sharing.</p></Show>
            <label class="tour-review-check"><input type="checkbox" checked={reviewed().has(item.key)} disabled={!!link() || bound() || busy() || !!item.capture && (!loaded().has(item.key) || failed().has(item.key))} onChange={e => setReviewed(s => { const next = new Set(s); e.currentTarget.checked ? next.add(item.key) : next.delete(item.key); return next; })} /><span>I've reviewed this picture and text{!item.capture ? " (text only)" : ""}.</span></label>
          </figcaption>
        </figure>}</For></div>
        <p class="text-caption text-muted" role="status">Reviewed {reviewed().size} of {items().length} picture/text views.</p><Show when={failed().size > 0}><button type="button" class="button" disabled={busy()} onClick={() => void load()}>Reload Preview</button></Show>
      </>}</Show>
      <Show when={bound()}><p role="status">Tour sent to {handoff()?.publicTitle}. It stays on the edition you reviewed.</p></Show>
      <Show when={link()}>{l => <div class="tour-share-result"><label class="field"><span class="field-label">Share link</span><input class="input" readOnly value={l().url} onFocus={e => e.currentTarget.select()} /></label><p class="text-caption text-muted">Expires {new Date(l().expiresAt).toLocaleString()}. This link stays on the edition you reviewed.</p><button type="button" class="button" onClick={() => { void navigator.clipboard.writeText(l().url).then(() => setCopied(true), () => setError("Couldn't copy the link. Select and copy it above.")); }}>{copied() ? "Copied" : "Copy Link"}</button></div>}</Show>
    </div>
    <footer class="tour-share-foot"><button type="button" class="button button-ghost" onClick={() => dialog.close()}>{link() || bound() ? "Done" : "Cancel"}</button><Show when={!link() && !bound()}><button type="button" class="button button-primary" disabled={!ready() || busy()} onClick={() => void create()}>{busy() ? destination() ? "Sending Tour…" : "Creating Link…" : destination() ? "Send Tour" : "Create Link"}</button></Show></footer>
  </dialog>;
}
