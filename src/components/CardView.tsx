import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show } from "solid-js";
import { checkViewData } from "../../shared/card-schema";
import { needsUpdatingText, TOOLKIT_VERSION, type CardInfo } from "../../shared/transcript-cards";
import { cardDataErrorText } from "../../shared/view-cards";
import { ApiError, getCardView, runSessionCardCommand, setCardTrust } from "../lib/api";
import { boxFocusGuard, CARD_BOX_MESSAGE, CARD_BOX_UNSUPPORTED, CARD_SHELL_ATTRS, cardBoxSupported, cardShellDoc, cardViewDoc, fromCardBox } from "../lib/card-box";
import type { CardControls } from "../lib/card-controls";
import { answerViewCall, boxHeight } from "../lib/card-view-host";
import { CardErrorBox } from "./TranscriptKind";
import { Icon } from "./ui";

/**
 * A card that draws its author's own view, in a sealed box (§chat.transcript-cards/sealed-box): the
 * shell frame in the card's place, the view's built code from the chat's own checkout
 * (§chat.transcript-cards/building), its calls answered for this card only
 * (§chat.transcript-cards/view-api, lib/card-view-host.ts), and redrawn on every save with its
 * data, answer and state kept, because they are Sova's (§chat.transcript-cards/redraw). A view
 * that doesn't build, fails to load, throws, was built for another toolkit, gets data that doesn't
 * fit its shape, or can't be walled off in this browser draws the card's error box with Reload;
 * nothing else in the chat notices.
 */

/** The view document's base: Sova's typography and controls on the theme's tokens (sent with each load). */
// The view's color-scheme stays `normal`, as its frames' do: a frame whose document's scheme differs
// from its element's gets an opaque backdrop, never the card's own background.
const BASE_CSS = `html{-webkit-text-size-adjust:100%;color-scheme:normal}
html,body{margin:0;padding:0;background:transparent}
body{color:var(--color-ink);font-family:var(--font-body),system-ui,sans-serif;font-size:var(--fs-body,14px);line-height:var(--lh-body,1.5);-webkit-font-smoothing:antialiased;overflow-wrap:anywhere}
h1,h2,h3,h4{font-family:var(--font-display),system-ui,sans-serif;margin:0 0 var(--space-2,8px)}
p{margin:0 0 var(--space-2,8px)}
code,pre{font-family:var(--font-mono),ui-monospace,monospace;font-size:var(--fs-mono,13px)}
button{display:inline-flex;align-items:center;justify-content:center;gap:var(--space-2,8px);min-height:var(--control-sm,28px);padding:0 var(--space-3,12px);border:1px solid var(--color-border-strong);border-radius:var(--r-md,6px);background:var(--color-surface);color:var(--color-ink);font:inherit;font-weight:var(--fw-medium,500);cursor:pointer}
button:hover{border-color:var(--color-accent)}
button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--color-accent);outline-offset:2px}
button:disabled{opacity:.5;cursor:default}
input,select,textarea{font:inherit;color:inherit;background:var(--color-sunken);border:1px solid var(--color-border);border-radius:var(--r-sm,4px);padding:var(--space-1,4px) var(--space-2,8px)}
.muted{color:var(--color-ink-muted)}`;

let shellDocCache: string | null = null;
export const shellDoc = () => (shellDocCache ??= cardShellDoc(cardViewDoc(BASE_CSS)));

/** The theme in use, as the box takes it: every token on the page's root, and whether it is light or dark. */
export function themeNow(): { css: string; theme: { name: string; scheme: "light" | "dark" } } {
  const root = document.documentElement;
  const cs = getComputedStyle(root);
  const decls: string[] = [];
  for (let i = 0; i < cs.length; i++) {
    const name = cs[i]!;
    if (name.startsWith("--")) decls.push(`${name}:${cs.getPropertyValue(name).trim().replace(/[<>{}]/g, "")}`);
  }
  const scheme = root.dataset.theme === "light" ? "light" : "dark";
  decls.push(`--sova-scheme:${scheme}`);
  return { css: `:root{${decls.join(";")}}`, theme: { name: root.dataset.theme ?? "dark", scheme } };
}

export const post = (shell: HTMLIFrameElement | undefined, m: Record<string, unknown>) => shell?.contentWindow?.postMessage({ [CARD_BOX_MESSAGE]: 1, ...m }, "*");

export default function CardView(props: { card: CardInfo; ctx: CardControls }) {
  let shell: HTMLIFrameElement | undefined;
  const [attempt, setAttempt] = createSignal(0);
  const [boxError, setBoxError] = createSignal<string | null>(null);
  const [code, setCode] = createSignal<{ hash: string; code: string } | null>(null);
  const [drawn, setDrawn] = createSignal<number | null>(null);
  const [asked, setAsked] = createSignal<number | null>(null);
  const [trustAsk, setTrustAsk] = createSignal<{ name: string; decide(on: boolean): void } | null>(null);
  let shellReady = false;

  /** What stops the view before it is loaded: the browser, the toolkit version, the data's shape. */
  const before = createMemo((): string | null => {
    attempt();
    if (!cardBoxSupported(globalThis.HTMLIFrameElement?.prototype)) return CARD_BOX_UNSUPPORTED;
    const built = props.card.view?.toolkit ?? 0;
    if (built !== TOOLKIT_VERSION) return needsUpdatingText(built);
    const decl = props.ctx.type(props.card.type);
    if (decl?.data !== undefined) {
      const c = checkViewData(decl.data, props.card.data);
      if (!c.ok) return `its data doesn't fit: ${cardDataErrorText(c.error)}`;
    }
    return null;
  });
  const error = () => before() ?? boxError();
  const reserve = () => props.card.view?.height ?? 160;
  const height = () => boxHeight(asked() ?? drawn() ?? reserve());

  /** What the view is told: plain JSON, never the page's store proxies (they can't cross into the box). */
  const init = () => JSON.parse(JSON.stringify(initOf()));
  const initOf = () => {
    const c = props.card;
    const a = c.answer;
    const s = props.ctx.session();
    return {
      card: {
        id: c.id,
        type: c.type,
        title: c.title,
        data: c.data,
        status: c.state,
        mode: c.answerMode,
        answer: a ? { text: a.text, value: "view" in a.value ? ((a.value.view as { value?: unknown })?.value ?? null) : a.value, by: a.by, at: a.at } : null,
      },
      state: props.ctx.viewState(c.id),
      session: { id: s.id, title: s.title, canAct: props.ctx.canAct() },
      theme: themeNow().theme,
    };
  };

  const draw = () => {
    const c = code();
    if (!c || !shellReady || before()) return;
    setBoxError(null);
    post(shell, { op: "load", css: themeNow().css, init: init(), code: c.code });
  };

  // The view's code: built now, then again on every save, until the card goes away.
  const abort = new AbortController();
  onCleanup(() => abort.abort());
  const follow = async () => {
    let have: string | null = null;
    while (!abort.signal.aborted) {
      try {
        const r = await getCardView(props.ctx.session().path, props.card.type, have, have !== null, abort.signal);
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

  const run = async (command: string, params: unknown) => {
    const path = props.ctx.session().path;
    try {
      return await runSessionCardCommand(path, props.card.id, command, params);
    } catch (err) {
      const trust = err instanceof ApiError ? (err.body as { needsTrust?: { owner?: unknown; name?: unknown } } | undefined)?.needsTrust : undefined;
      if (!trust || typeof trust.owner !== "string" || typeof trust.name !== "string") throw err;
      const owner = trust.owner;
      // The card asks once (§chat.transcript-cards/trust): Trust runs it, Not Now runs nothing.
      const yes = await new Promise<boolean>((resolve) => setTrustAsk({ name: trust.name as string, decide: resolve }));
      setTrustAsk(null);
      if (!yes) throw err;
      await setCardTrust(owner, true);
      return await runSessionCardCommand(path, props.card.id, command, params);
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
      else if (m.op === "api")
        void answerViewCall(m.msg, {
          card: () => props.card,
          canAct: () => props.ctx.canAct(),
          setState: (v) => props.ctx.setViewState(props.card.id, v),
          stage: (t) => props.ctx.stage(t),
          answerNow: (v) => props.ctx.answerNow(props.card, v),
          pick: (v, text) => props.ctx.pick(props.card, { value: v, text }),
          run,
          resize: (h) => setAsked(h),
        }).then((reply) => reply && post(shell, { op: "api", msg: reply }));
    };
    addEventListener("message", onMessage);
    // The theme changes on the page's root: the box follows at once, with no reload.
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
    // Its document only now, with the wall's attributes already on the frame and the page listening.
    shell.srcdoc = shellDoc();
    if (!before()) void follow();
  });

  // A new revision of its data, an answer given anywhere, its state, whether it can act: the view hears it.
  createEffect(
    on(
      () => [props.card.data, props.card.answer, props.card.state, props.ctx.viewState(props.card.id), props.ctx.canAct()],
      () => {
        if (shellReady && code()) post(shell, { op: "api", msg: { push: "update", init: init() } });
      },
      { defer: true },
    ),
  );

  const reload = () => {
    setAttempt((n) => n + 1);
    setBoxError(null);
    if (before()) return;
    if (code()) draw();
    else void getCardView(props.ctx.session().path, props.card.type).then((r) => (r.ok ? (setCode({ hash: r.hash, code: r.code }), draw()) : setBoxError(r.error)));
  };

  return (
    <div class="card-view">
      <Show when={error()}>{(why) => <CardErrorBox why={why().trim().replace(/\.$/, "")} reload={reload} />}</Show>
      <iframe
        ref={(el) => {
          // The wall's attributes, before the frame is in the page or has a document.
          for (const [k, v] of Object.entries(CARD_SHELL_ATTRS)) el.setAttribute(k, v);
          shell = el;
        }}
        class="card-view-box"
        title={`${props.card.title} (card view)`}
        style={{ height: `${height()}px`, display: error() ? "none" : "block" }}
      />
      <Show when={trustAsk()}>
        {(a) => (
          <div class="banner banner-warn transcript-card-trust" role="group" aria-label={`Trust ${a().name}'s cards`}>
            <Icon name="attention" class="banner-icon" />
            <div class="banner-main">
              <p class="banner-title">Let {a().name}'s cards act for you?</p>
              <p class="banner-body">They can then run any Sova command, such as sending messages or merging, without asking again.</p>
            </div>
            <div class="banner-action">
              <button type="button" class="button button-sm button-primary" onClick={() => a().decide(true)}>
                Trust {a().name}'s Cards
              </button>
              <button type="button" class="button button-sm button-ghost" onClick={() => a().decide(false)}>
                Not Now
              </button>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}
