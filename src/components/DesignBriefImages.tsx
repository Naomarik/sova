import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import type { DesignAsset, DesignAssetCatalogue } from "../../shared/design-assets";
import { assetKindWord, assetsOfRun, kindChoices, assetStateLine, imageUsed, usedCount } from "../lib/design-brief";
import { useDesignStore, type DesignStore } from "../lib/design-store";
import { hostOf } from "../lib/mesh";
import type { DesignRunView } from "../lib/design-ui";
import { Select, TextArea, Toggle } from "./form";

const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

/** The chat's image list, fetched again whenever the view says something changed. */
export function createAssetCatalogue(store: DesignStore) {
  const [catalogue, setCatalogue] = createSignal<DesignAssetCatalogue | null>(null);
  let inFlight = false;
  let again = false;
  const load = () => {
    if (inFlight) {
      again = true;
      return;
    }
    inFlight = true;
    store.api
      .assets()
      .then(setCatalogue)
      .catch(() => {})
      .finally(() => {
        inFlight = false;
        if (again) {
          again = false;
          load();
        }
      });
  };
  createEffect(on(store.view, load));
  return catalogue;
}

function AssetCard(props: { asset: DesignAsset; used: boolean; store: DesignStore; readOnly?: boolean; onUse(on: boolean): void; onOpen(): void }) {
  return (
    <article class="design-asset" classList={{ "design-asset-off": !props.used }} aria-label={`Image ${props.asset.name}`}>
      <button type="button" class="design-asset-open" aria-label={`Details of ${props.asset.name}`} onClick={() => props.onOpen()}>
        <img src={props.store.api.assetUrl(props.asset.name, "small")} alt={props.asset.description?.description ?? ""} loading="lazy" />
      </button>
      <Toggle
        class="design-asset-use"
        label={
          <span class="design-asset-kind" title={assetKindWord(props.asset)}>
            {assetKindWord(props.asset)}
          </span>
        }
        ariaLabel={`Use ${props.asset.name}`}
        checked={props.used}
        disabled={props.readOnly}
        onChange={(on) => props.onUse(on)}
      />
      <p class="text-caption text-muted design-asset-state" title={assetStateLine(props.asset)}>
        {assetStateLine(props.asset)}
      </p>
    </article>
  );
}

/** Setup's images: the ones the run starts with (attached when the Lookbook was asked for, or pasted since), read-only.
    Their place is kept whether or not there are any, since the list arrives after the card is drawn: nothing below moves. */
export function DesignSetupImages(props: { run: DesignRunView; store: DesignStore }) {
  const catalogue = createAssetCatalogue(props.store);
  const assets = createMemo(() => assetsOfRun(catalogue(), props.run));
  return (
    <section class="design-setup-images" aria-label="Images for this run">
      <h4 class="design-setup-label">Images{assets().length ? ` · ${assets().length}` : ""}</h4>
      <Show when={assets().length > 0} fallback={<p class="text-caption text-muted design-setup-thumbs">{catalogue() ? "Images you attach when you ask for a Lookbook show here." : ""}</p>}>
        <ul class="design-setup-thumbs">
          <For each={assets()}>
            {(a) => (
              <li class="design-setup-thumb" title={`${a.name} · ${assetKindWord(a)}`}>
                <img src={props.store.api.assetUrl(a.name, "small")} alt={`${a.name}, ${assetKindWord(a)}`} loading="lazy" />
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
}

/** The images designers will use: a size of its own, and its cards land where they were reserved. */
export function DesignBriefImages(props: { run: DesignRunView; store: DesignStore; catalogue: DesignAssetCatalogue | null; onOpen(name: string): void; readOnly?: boolean }) {
  const [held, setHeld] = createSignal<Record<string, boolean>>({});
  const [error, setError] = createSignal("");
  const brief = () => props.run.brief;
  const assets = createMemo(() => assetsOfRun(props.catalogue, props.run));
  const names = createMemo(() => assets().map((a) => a.name), undefined, { equals: (a, b) => a.length === b.length && a.every((x, i) => x === b[i]) });
  const used = (name: string) => imageUsed(brief(), held(), name);
  // A click shows at once; the server's word replaces it when it says the same.
  createEffect(() => {
    const left = Object.entries(held()).filter(([name, on]) => imageUsed(brief(), {}, name) !== on);
    if (left.length !== Object.keys(held()).length) setHeld(Object.fromEntries(left));
  });
  const setUse = (name: string, on: boolean) => {
    setHeld({ ...held(), [name]: on });
    setError("");
    props.store.api.briefImage(props.run.id, name, on).then(
      () => props.store.refresh(),
      (e) => {
        const { [name]: _gone, ...rest } = held();
        setHeld(rest);
        setError(message(e, "That image couldn't be changed. Try again."));
      },
    );
  };
  const of = (name: string) => assets().find((a) => a.name === name);
  const skipped = () => (props.catalogue?.captures ?? []).flatMap((c) => c.skipped);
  const count = () => usedCount(assets(), held(), brief());
  return (
    <section aria-label="Images designers will use">
      <h4 class="design-brief-title">
        Images designers will use · {count()} of {assets().length}
      </h4>
      <p class={`text-caption design-asset-error${error() ? " field-error" : " text-muted"}`} role={error() ? "alert" : undefined}>
        {error() || (assets().length === 0 ? "The page's images show here once they're captured." : "")}
      </p>
      <div class="design-assets">
        <For each={names()}>
          {(name) => (
            <Show when={of(name)}>
              {(a) => <AssetCard asset={a()} used={used(name)} store={props.store} readOnly={props.readOnly} onUse={(on) => setUse(name, on)} onOpen={() => props.onOpen(name)} />}
            </Show>
          )}
        </For>
      </div>
      <Show when={skipped().length > 0}>
        <details class="design-asset-skipped">
          <summary>{skipped().length} images not brought back</summary>
          <ul>
            <For each={skipped()}>
              {(s) => (
                <li class="text-caption">
                  <code class="design-link-url">{s.what}</code> · {s.reason}
                </li>
              )}
            </For>
          </ul>
        </details>
      </Show>
    </section>
  );
}

/** One image opened: what was said about it, your note and kind, Describe Again, and download. It covers the images' pane, so nothing moves. */
export function DesignBriefImageDetail(props: { asset: DesignAsset; store: DesignStore; onClose(): void }) {
  const [note, setNote] = createSignal(props.asset.note ?? "");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const act = async (run: () => Promise<unknown>, fallback: string) => {
    setBusy(true);
    setError("");
    try {
      await run();
      props.store.refresh();
    } catch (e) {
      setError(message(e, fallback));
    } finally {
      setBusy(false);
    }
  };
  const d = () => props.asset.description;
  // A page capture's image is never offered `screenshot`: only a picture you pasted can be one.
  const kinds = () => kindChoices(props.asset).map((k) => ({ value: k, label: k }));
  return (
    <div class="design-asset-detail" role="group" aria-label={`Image ${props.asset.name}`}>
      <div class="design-brief-text-head">
        <h4 class="design-brief-title">{props.asset.name}</h4>
        <span class="text-caption text-muted design-brief-note">{props.asset.source === "yours" ? "Yours" : props.asset.context.pageUrl ?? ""}</span>
        <button type="button" class="button button-sm button-ghost" onClick={() => props.onClose()}>
          Close
        </button>
      </div>
      <div class="design-asset-detail-body">
        <div class="design-asset-detail-picture">
          <img src={props.store.api.assetUrl(props.asset.name, "small")} alt={d()?.description ?? props.asset.name} />
        </div>
        <dl>
          <Show when={d()} fallback={<dd class="text-muted">{props.asset.describeError ?? "Being described."}</dd>}>
            {(x) => (
              <>
                <dt>Shows</dt>
                <dd>{x().description}</dd>
                <dt>Where it sat</dt>
                <dd>{x().placement}</dd>
                <dt>How to use it</dt>
                <dd>{x().usage}</dd>
              </>
            )}
          </Show>
        </dl>
        <Select label="Kind" value={props.asset.chosenKind ?? props.asset.cdKind ?? d()?.kind ?? ""} options={kinds()} disabled={busy()} onChange={(kind) => void act(() => props.store.api.imageNote(props.asset.name, { kind }), "That kind couldn't be saved. Try again.")} />
        <TextArea label="Your note, which overrides everything else said about it" rows="2" value={note()} onInput={setNote} />
        <Show when={error()}>
          <p class="field-error" role="alert">
            {error()}
          </p>
        </Show>
        <div class="design-asset-detail-actions">
          <button type="button" class="button button-sm" disabled={busy() || note() === (props.asset.note ?? "")} onClick={() => void act(() => props.store.api.imageNote(props.asset.name, { note: note() || null }), "Your note couldn't be saved. It's still in the box.")}>
            Save Note
          </button>
          <button type="button" class="button button-sm" disabled={busy() || props.asset.describeAgain} title={props.asset.describeAgain ? "Being described again." : undefined} onClick={() => void act(() => props.store.api.imageDescribe(props.asset.name), "That didn't start. Try again.")}>
            Describe Again
          </button>
          <a class="button button-sm" href={props.store.api.assetUrl(props.asset.name, "original")} download={`${props.asset.name}.${props.asset.ext}`}>
            Download Original
          </a>
        </div>
      </div>
    </div>
  );
}

/** The Gallery's Page Assets: every image this chat holds, to look through and download (a15). One size, scrolling inside. */
export function DesignPageAssets(props: { path: string }) {
  const store = useDesignStore(props.path, hostOf(props.path));
  const catalogue = createAssetCatalogue(store);
  const [openImage, setOpenImage] = createSignal<string | null>(null);
  const assets = () => catalogue()?.assets ?? [];
  const names = createMemo(() => assets().map((a) => a.name), undefined, { equals: (a, b) => a.length === b.length && a.every((x, i) => x === b[i]) });
  const of = (name: string) => assets().find((a) => a.name === name);
  const usage = () => catalogue()?.describeUsage;
  return (
    <section class="gallery-section design-page-assets" aria-labelledby="gallery-page-assets">
      <div class="gallery-head">
        <h3 class="text-eyebrow" id="gallery-page-assets">
          Page Assets · {assets().length}
        </h3>
        <span class="text-caption text-muted">{usage() && usage()!.cost > 0 ? `Described for $${usage()!.cost.toFixed(2)}` : ""}</span>
      </div>
      <div class="gallery-scroll">
        <Show
          when={assets().length > 0}
          fallback={
            <Show when={catalogue()}>
              <div class="empty gallery-empty">
                <p class="empty-body">0 images in this chat. A link set to Use Its Images, or an image pasted into the Creative Director's box, adds them here.</p>
              </div>
            </Show>
          }
        >
          <div class="design-assets">
            <For each={names()}>
              {(name) => (
                <Show when={of(name)}>
                  {(a) => (
                    <article class="design-asset" aria-label={`Image ${a().name}`}>
                      <button type="button" class="design-asset-open" aria-label={`Details of ${a().name}`} onClick={() => setOpenImage(name)}>
                        <img src={store.api.assetUrl(name, "small")} alt={a().description?.description ?? ""} loading="lazy" />
                      </button>
                      <div class="design-asset-row">
                        <span class="text-mono design-asset-name">{name}</span>
                        <span class="design-asset-kind" title={assetKindWord(a())}>
                          {assetKindWord(a())}
                        </span>
                      </div>
                      <p class="text-caption text-muted design-asset-state" title={assetStateLine(a())}>
                        {assetStateLine(a())}
                      </p>
                        <a class="button button-sm button-ghost design-asset-download" href={store.api.assetUrl(name, "original")} download={`${name}.${a().ext}`} aria-label={`Download ${name}`}>
                          Download
                        </a>
                    </article>
                  )}
                </Show>
              )}
            </For>
          </div>
        </Show>
      </div>
      <Show when={of(openImage() ?? "")}>{(a) => <DesignBriefImageDetail asset={a()} store={store} onClose={() => setOpenImage(null)} />}</Show>
    </section>
  );
}
