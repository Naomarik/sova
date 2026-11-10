import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import type { DesignAsset, DesignAssetCatalogue } from "../../shared/design-assets";
import { DESIGN_ASSET_KINDS } from "../../shared/design-assets";
import { assetKindWord, assetsOfRun, assetStateLine, usedCount, type WithUnused } from "../lib/design-brief";
import type { DesignStore } from "../lib/design-store";
import type { DesignRunView } from "../lib/design-ui";
import { Select, TextArea } from "./form";

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
      <label class="toggle design-asset-use">
        <input type="checkbox" checked={props.used} disabled={props.readOnly} aria-label={`Use ${props.asset.name}`} onChange={(e) => props.onUse(e.currentTarget.checked)} />
        <span class="toggle-box" />
        <span class="design-asset-kind" title={assetKindWord(props.asset)}>
          {assetKindWord(props.asset)}
        </span>
      </label>
      <p class="text-caption text-muted design-asset-state" title={assetStateLine(props.asset)}>
        {assetStateLine(props.asset)}
      </p>
    </article>
  );
}

/** The images designers will use: a size of its own, and its cards land where they were reserved. */
export function DesignBriefImages(props: { run: DesignRunView; store: DesignStore; catalogue: DesignAssetCatalogue | null; onOpen(name: string): void; readOnly?: boolean }) {
  const [held, setHeld] = createSignal<Record<string, boolean>>({});
  const [error, setError] = createSignal("");
  const brief = () => props.run.brief as WithUnused | undefined;
  const assets = createMemo(() => assetsOfRun(props.catalogue, props.run));
  const names = createMemo(() => assets().map((a) => a.name), undefined, { equals: (a, b) => a.length === b.length && a.every((x, i) => x === b[i]) });
  const used = (name: string) => held()[name] ?? !(brief()?.unused ?? []).includes(name);
  // A click shows at once; the server's word replaces it when it says the same.
  createEffect(() => {
    const unused = brief()?.unused ?? [];
    const left = Object.entries(held()).filter(([name, on]) => unused.includes(name) === on);
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
  const count = () => usedCount(assets(), held(), brief()?.unused ?? []);
  const notes = () => props.catalogue?.captures.at(-1)?.notes;
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
      <Show when={notes() && (notes()!.colors.length > 0 || notes()!.fonts.length > 0)}>
        <p class="text-caption text-muted design-asset-notes">
          Colors: {notes()!.colors.map((c) => c.hex).join(", ") || "none read"} · Fonts: {notes()!.fonts.map((f) => f.family).join(", ") || "none read"}
        </p>
      </Show>
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
  const kinds = () => DESIGN_ASSET_KINDS.map((k) => ({ value: k, label: k }));
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
        <img src={props.store.api.assetUrl(props.asset.name, "small")} alt={d()?.description ?? props.asset.name} />
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
        <Select label="Kind" value={props.asset.chosenKind ?? d()?.kind ?? ""} options={kinds()} disabled={busy()} onChange={(kind) => void act(() => props.store.api.imageNote(props.asset.name, { kind }), "That kind couldn't be saved. Try again.")} />
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
