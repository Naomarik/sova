import { createSignal, onCleanup, onMount, Show } from "solid-js";
import type { OwnDrawing } from "../../shared/drawing-kinds";
import { needsUpdatingText, TOOLKIT_VERSION } from "../../shared/transcript-cards";
import { getDrawingView } from "../lib/api";
import { boxFocusGuard, CARD_BOX_UNSUPPORTED, CARD_SHELL_ATTRS, cardBoxSupported, fromCardBox } from "../lib/card-box";
import type { OwnKind } from "../lib/card-controls";
import { answerDrawingCall, boxHeight } from "../lib/card-view-host";
import { announce, copyText } from "../lib/ui-state";
import { post, shellDoc, themeNow } from "./CardView";
import { CardErrorBox } from "./TranscriptKind";

/**
 * A `vis <owner>.<name>` fence of one of the chat's own kinds (§chat.transcript-cards/drawing-kinds):
 * Sova's figure (its title or the kind as an eyebrow, Source, Copy, its caption) around the kind's
 * view, run in the same sealed box as a card's (§chat.transcript-cards/sealed-box), told only the
 * fence's body, and redrawn on every save of its view (§chat.transcript-cards/redraw). A drawing
 * only draws: the box answers its size and nothing else, so it has no answer, stages nothing and
 * runs no command.
 */
export default function DrawingView(props: { decl: OwnKind; drawing: OwnDrawing; fence: string; body: string; session: () => { path: string; id: string; title: string } }) {
  let shell: HTMLIFrameElement | undefined;
  const [source, setSource] = createSignal(false);
  const [boxError, setBoxError] = createSignal<string | null>(null);
  const [code, setCode] = createSignal<{ hash: string; code: string } | null>(null);
  const [drawn, setDrawn] = createSignal<number | null>(null);
  let shellReady = false;
  const before = (): string | null => {
    if (!cardBoxSupported(globalThis.HTMLIFrameElement?.prototype)) return CARD_BOX_UNSUPPORTED;
    if (props.decl.toolkit !== TOOLKIT_VERSION) return needsUpdatingText(props.decl.toolkit);
    return null;
  };
  const error = () => before() ?? boxError();
  const height = () => boxHeight(drawn() ?? props.decl.height ?? 160);
  const label = () => props.drawing.title ?? props.drawing.caption ?? props.decl.kind;
  // What the view is told: the fence's body (text or checked data), as a card's view is told its data.
  const init = () =>
    JSON.parse(
      JSON.stringify({
        card: { id: "drawing", type: props.decl.kind, title: props.drawing.title ?? props.decl.kind, data: props.drawing.data, status: "done", mode: "none", answer: null },
        state: null,
        session: { id: props.session().id, title: props.session().title, canAct: false },
        theme: themeNow().theme,
      }),
    );
  const draw = () => {
    const c = code();
    if (!c || !shellReady || before()) return;
    setBoxError(null);
    post(shell, { op: "load", css: themeNow().css, init: init(), code: c.code });
  };
  const abort = new AbortController();
  onCleanup(() => abort.abort());
  const follow = async () => {
    let have: string | null = null;
    while (!abort.signal.aborted) {
      try {
        const r = await getDrawingView(props.session().path, props.decl.kind, have, have !== null, abort.signal);
        if (r.hash === have) continue;
        have = r.hash;
        if (r.ok) {
          setCode({ hash: r.hash, code: r.code });
          draw();
        } else {
          setCode(null);
          setBoxError(r.error);
          if (r.outdated) return;
        }
      } catch {
        if (abort.signal.aborted) return;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  };
  onMount(() => {
    if (!shell) return;
    const guard = boxFocusGuard(document, shell, () => post(shell, { op: "focus?" }));
    const onMessage = (e: MessageEvent) => {
      const m = fromCardBox(e, shell?.contentWindow);
      if (!m) return;
      if (m.op === "shell-ready") {
        shellReady = true;
        draw();
      } else if (m.op === "height") setDrawn(m.height);
      else if (m.op === "error") setBoxError(m.message.split("\n")[0] ?? m.message);
      else if (m.op === "focus") guard.onBoxFocus(m.user);
      else if (m.op === "api") {
        const reply = answerDrawingCall(m.msg, (h) => setDrawn(h));
        if (reply) post(shell, { op: "api", msg: reply });
      }
    };
    addEventListener("message", onMessage);
    const themeWatch = new MutationObserver(() => {
      const t = themeNow();
      post(shell, { op: "theme", css: t.css });
      post(shell, { op: "api", msg: { push: "theme", theme: t.theme } });
    });
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "data-theme", "class"] });
    onCleanup(() => {
      removeEventListener("message", onMessage);
      themeWatch.disconnect();
      guard.dispose();
    });
    shell.srcdoc = shellDoc();
    if (!before()) void follow();
  });
  const reload = () => {
    setBoxError(null);
    if (before()) return;
    if (code()) draw();
    else void getDrawingView(props.session().path, props.decl.kind).then((r) => (r.ok ? (setCode({ hash: r.hash, code: r.code }), draw()) : setBoxError(r.error)));
  };
  return (
    <figure class="vis vis-own" data-vis-own={props.decl.kind} aria-label={label()}>
      <div class="vis-head">
        <Show when={props.drawing.title} fallback={<span class="vis-eyebrow">{props.decl.kind}</span>}>
          <span class="vis-title">{props.drawing.title}</span>
        </Show>
        <button class="button button-sm button-ghost vis-action" type="button" aria-pressed={source()} onClick={() => setSource(!source())}>
          <span class="icon icon-sm" style={{ "--icon": `url(/icons/${source() ? "eye" : "terminal"}.svg)` }} aria-hidden="true" />
          {source() ? "Visual" : "Source"}
        </button>
        <button
          class="button button-sm button-ghost vis-action"
          type="button"
          onClick={async () => {
            if (await copyText(props.fence, "Copied the visual's source.")) announce("Copied the visual's source.");
          }}
        >
          <span class="icon icon-sm" style={{ "--icon": "url(/icons/copy.svg)" }} aria-hidden="true" />
          Copy
        </button>
      </div>
      <Show when={source()}>
        <pre class="vis-source">
          <code>{props.body}</code>
        </pre>
      </Show>
      <div class="vis-body" hidden={source()}>
        <Show when={error()}>{(why) => <CardErrorBox why={why().trim().replace(/\.$/, "")} reload={reload} noun="drawing" />}</Show>
        <iframe
          ref={(el) => {
            for (const [k, v] of Object.entries(CARD_SHELL_ATTRS)) el.setAttribute(k, v);
            shell = el;
          }}
          class="card-view-box"
          title={`${label()} (drawing)`}
          style={{ height: `${height()}px`, display: error() ? "none" : "block", width: "100%" }}
        />
      </div>
      <Show when={props.drawing.caption}>
        <figcaption class="vis-caption">{props.drawing.caption}</figcaption>
      </Show>
    </figure>
  );
}
