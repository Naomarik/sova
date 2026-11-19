import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { SessionShareDesignKind, SessionShareLookbook } from "../../shared/session-share";
import { DESIGN_SHARE_SHELL_ATTRS, DESIGN_STREAM_ATTRS } from "../lib/design-frame";
import { designsCount, designsLine, designTiles, loadDesignDoc, SIGNED_IN_PICTURES, type DesignDocUrl, type DesignTile, type ThumbState } from "../lib/session-shares";
import { runsDesigns } from "../share/lookbook-model";
import { Icon } from "./ui";

/** Retry shows for a design that hasn't loaded after this long, as for one that failed. */
const SLOW_DESIGN_MS = 15_000;
/** Design documents read at once: a Lookbook of many versions doesn't ask for all of them together. */
const AT_ONCE = 4;

const RUNS = runsDesigns(typeof HTMLIFrameElement === "undefined" ? undefined : HTMLIFrameElement.prototype);

/** A small queue: at most AT_ONCE reads run, the rest wait their turn. */
function queue(limit: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  const next = () => {
    if (running >= limit) return;
    const go = waiting.shift();
    if (!go) return;
    running++;
    go();
  };
  return <T,>(job: () => Promise<T>): Promise<T> =>
    new Promise<T>((ok, fail) => {
      waiting.push(() =>
        job()
          .then(ok, fail)
          .finally(() => {
            running--;
            next();
          }),
      );
      next();
    });
}

/**
 * Every version of every design a preview shares, each read at once and drawn small (never lazily:
 * each must be on screen before anything is shared), with Retry for one that failed or is slow.
 * `onState` reports which loaded, for the gate on Create, Update to Now and Stop Following Live,
 * beside the images'. A version is drawn from the very document a recipient gets, walled as the
 * app walls its own design cards: running where this browser can wall a page's code, else a still.
 */
export function DesignsShared(props: { lookbooks: readonly SessionShareLookbook[]; signedIn?: boolean; url: DesignDocUrl; onState(t: ThumbState): void }) {
  const tiles = createMemo(() => designTiles(props.lookbooks));
  const groups = createMemo(() => props.lookbooks.map((lb) => ({ lb, tiles: tiles().filter((t) => t.lookbook === lb.id) })).filter((g) => g.tiles.length > 0));
  /** Each loaded index's document, kept so it never reads again. */
  const [docs, setDocs] = createSignal<ReadonlyMap<number, string>>(new Map());
  const [failed, setFailed] = createSignal<ReadonlySet<number>>(new Set());
  const [slow, setSlow] = createSignal(false);
  const loaded = createMemo<ReadonlySet<number>>(() => new Set(docs().keys()));
  const state = (): ThumbState => ({ total: tiles().length, loaded: loaded(), failed: failed() });
  createEffect(() => props.onState(state()));

  const run = queue(AT_ONCE);
  let aborts = new AbortController();
  onCleanup(() => aborts.abort());
  const kind = (): SessionShareDesignKind => (RUNS ? "tile" : "tile-still");
  const read = (i: number, t: DesignTile) => {
    const signal = aborts.signal;
    return run(async () => {
      if (signal.aborted || docs().has(i)) return;
      const html = await loadDesignDoc(props.url(t.label, t.n, kind()), signal);
      if (signal.aborted) return;
      setDocs((m) => new Map([...m, [i, html]]));
    }).catch(() => {
      if (!signal.aborted) setFailed((f) => new Set([...f, i]));
    });
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const readAll = () => {
    clearTimeout(timer);
    setSlow(false);
    timer = setTimeout(() => setSlow(true), SLOW_DESIGN_MS);
    tiles().forEach((t, i) => void read(i, t));
  };
  readAll();
  onCleanup(() => clearTimeout(timer));
  const retry = () => {
    // Reads still on their way are dropped and asked again with the failed ones.
    aborts.abort();
    aborts = new AbortController();
    setFailed(new Set<number>());
    readAll();
  };

  const line = () => designsLine(state());
  const showRetry = () => failed().size > 0 || (slow() && loaded().size < tiles().length);
  const index = (t: DesignTile) => tiles().indexOf(t);
  return (
    <section class="stack-2" aria-labelledby="share-designs-label">
      <h3 class="text-eyebrow" id="share-designs-label">
        {designsCount(tiles())}
      </h3>
      <Show when={props.signedIn}>
        <p class="usage-note">{SIGNED_IN_PICTURES}</p>
      </Show>
      <p class="usage-note">Designs are shared as they are: every version shown here goes out.</p>
      <div class="share-designs">
        <For each={groups()}>
          {(g) => (
            <div class="share-designs-group" role="group" aria-label={groups().length > 1 ? `Lookbook ${groups().indexOf(g) + 1}` : "Lookbook"}>
              <Show when={groups().length > 1}>
                <p class="text-caption text-muted share-designs-group-label">Lookbook {groups().indexOf(g) + 1}</p>
              </Show>
              <ul class="share-design-tiles">
                <For each={g.tiles}>
                  {(t) => {
                    const i = index(t);
                    const title = () => [t.name, t.direction, t.modelName].filter(Boolean).join(" · ");
                    return (
                      <li class="share-design-tile" classList={{ "share-design-tile-failed": failed().has(i) }} title={title()}>
                        <div class="share-design-pic">
                          <Show when={docs().get(i)} fallback={<span class="share-design-wait" aria-hidden="true" />}>
                            {(html) => <DesignTileFrame html={html()} runs={RUNS} title={`Design ${title()}`} />}
                          </Show>
                        </div>
                        <p class="share-design-name">
                          <span class="share-design-letter">{t.name}</span>
                          <Show when={t.direction}>
                            <span class="text-muted"> · {t.direction}</span>
                          </Show>
                        </p>
                        <p class="share-design-model text-muted">{t.modelName}</p>
                      </li>
                    );
                  }}
                </For>
              </ul>
            </div>
          )}
        </For>
      </div>
      <Show when={line() || showRetry()}>
        <div class="share-thumbs-state">
          <Show when={line()}>{(l) => <p class="usage-note text-muted" role="status">{l()}</p>}</Show>
          <Show when={showRetry()}>
            <button type="button" class="button button-sm" onClick={retry}>
              <Icon name="refresh" small />
              Retry Designs
            </button>
          </Show>
        </div>
      </Show>
    </section>
  );
}

/** One version, drawn small from the document a recipient gets: its frame's policy and sandbox are
    on the element before its document is named, as the app's own design cards are. */
function DesignTileFrame(props: { html: string; runs: boolean; title: string }) {
  const seal = (el: HTMLIFrameElement) => {
    // A share's shell loads the page as a blob: document (so it can't read the link from its
    // baseURI); its frame takes the share shell's attributes, which let that inner frame load.
    const a = props.runs ? DESIGN_SHARE_SHELL_ATTRS : DESIGN_STREAM_ATTRS;
    el.setAttribute("sandbox", a.sandbox);
    el.setAttribute("csp", a.csp);
    el.setAttribute("referrerpolicy", a.referrerpolicy);
    el.setAttribute("tabindex", "-1");
    el.srcdoc = props.html;
  };
  return (
    <div class="share-design-scale" inert>
      <iframe class="share-design-frame" ref={seal} title={props.title} />
    </div>
  );
}
