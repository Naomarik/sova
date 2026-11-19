import { createEffect, createMemo, createSignal, Show } from "solid-js";
import type { SessionShareDesign } from "../../shared/session-share";
import { DesignStage, RUNS, SizeSwitch, VersionPicker, type DesignSize } from "./Lookbook";
import { designHash, designPagePath, findDesign, STILL_LINE, versionShown, type DesignAddress, type DesignUrls } from "./lookbook-model";
import type { SessionFeed } from "./SessionShareApp";
import { Select } from "../components/form";

/**
 * One design on its own page under the share link (Open in New Tab, §app.session-share/content):
 * a thin bar (design picker, version picker, Desktop/Phone on a wide screen, Close) over the page,
 * drawn behind the same wall as in the conversation. It reads the share as the conversation does,
 * so a link that dies takes this page with it, and a design that leaves the share leaves it too.
 * Every answer carries all of the view's Lookbooks, so the newest page alone finds any design.
 */
export function DesignPage(props: { token: string; first: DesignAddress; feed: SessionFeed; urls: DesignUrls; runs?: boolean }) {
  const runs = () => props.runs ?? RUNS;
  const [at, setAt] = createSignal<DesignAddress>(props.first);
  const [size, setSize] = createSignal<DesignSize>("desktop");
  const hit = createMemo(() => findDesign(props.feed.view()?.lookbooks, at().label));
  const every = createMemo<SessionShareDesign[]>(() => (props.feed.view()?.lookbooks ?? []).flatMap((lb) => lb.designs));
  const v = () => {
    const h = hit();
    return h ? versionShown(h.design, at().v) : 0;
  };

  const move = (a: DesignAddress) => {
    setAt(a);
    history.replaceState(history.state, "", designPagePath(props.token, a));
  };
  createEffect(() => {
    const h = hit();
    const title = props.feed.view()?.title;
    if (h) document.title = title ? `${h.design.label} · ${title}` : `Design ${h.design.label}`;
  });
  const close = () => {
    window.close();
    // A tab the browser won't let a page close (opened by hand, or with history) goes back to the conversation.
    setTimeout(() => location.assign(`/s/${props.token}${designHash(at())}`), 150);
  };
  const option = (d: SessionShareDesign) => (d.style.trim() ? `${d.label} · ${d.style}` : `Design ${d.label}`);
  return (
    <main class="lb-page">
      <Show
        when={!props.feed.problem()}
        fallback={
          <div class="empty share-empty">
            <p class="empty-title">{props.feed.problem()!.title}</p>
            <p class="empty-body">{props.feed.problem()!.body}</p>
          </div>
        }
      >
        <Show
          when={hit()}
          fallback={
            <div class="empty share-empty">
              <Show when={props.feed.view()} fallback={<p class="empty-title">Loading the design.</p>}>
                <p class="empty-title">This design isn't part of the share.</p>
                <p class="empty-body">The conversation it came from is still here.</p>
                <a class="button empty-action" href={`/s/${props.token}`}>
                  Open the Conversation
                </a>
              </Show>
            </div>
          }
        >
          {(h) => (
            <>
              <div class="lb-page-bar">
                <Select
                  class="lb-page-design"
                  label="Design"
                  hideLabel
                  value={h().design.label}
                  options={every().map((d) => ({ value: d.label, label: option(d) }))}
                  onChange={(label) => move({ label })}
                />
                <VersionPicker d={h().design} v={v()} onPick={(n) => move({ label: h().design.label, v: n })} />
                <SizeSwitch size={size()} onSize={setSize} />
                <span class="lb-page-spacer" />
                <Show when={h().design.modelName}>
                  <span class="text-caption text-muted lb-page-model">{h().design.modelName}</span>
                </Show>
                <button type="button" class="button button-sm lb-page-close" onClick={close}>
                  <span class="icon icon-sm lb-icon-close" aria-hidden="true" />
                  Close
                </button>
              </div>
              <Show when={props.feed.offline()}>
                <p class="lb-page-note" role="status">
                  Offline. We'll keep trying, and the page stays as it is.
                </p>
              </Show>
              <Show when={!runs()}>
                <p class="lb-page-note">{STILL_LINE}</p>
              </Show>
              <DesignStage d={h().design} v={v()} size={size()} urls={props.urls} runs={runs()} />
            </>
          )}
        </Show>
      </Show>
    </main>
  );
}
