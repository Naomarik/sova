import { createSignal, Match, Show, Switch, type JSX } from "solid-js";
import { authState, unlock, unlockFailure } from "../lib/auth";

/**
 * The unlock screen: what a browser without the token sees instead of the app.
 * It makes no request until the button is pressed, so it renders whatever the server would refuse.
 */
export function Unlock() {
  const [token, setToken] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    if (busy() || !token().trim()) return;
    setBusy(true);
    // A page unlocked by hand starts over, so nothing it fetched while refused is kept.
    if ((await unlock(token())) === "ok") location.reload();
    else setBusy(false);
  };

  return (
    // The window's height, as the shell's: the document itself never scrolls.
    <main class="empty" style={{ height: "100%", "box-sizing": "border-box", "overflow-y": "auto", "justify-content": "center" }}>
      <h1 class="empty-title">Unlock Sova</h1>
      <p class="empty-body">This browser hasn't been given this Sova's access token yet.</p>
      <form class="field empty-action" style={{ width: "min(100%, 28rem)", "text-align": "left" }} onSubmit={submit}>
        <label class="field-label" for="unlock-token">
          Access token
        </label>
        <input
          id="unlock-token"
          class="input"
          type="password"
          autocomplete="off"
          spellcheck={false}
          autofocus
          value={token()}
          onInput={(e) => setToken(e.currentTarget.value)}
        />
        <Show when={unlockFailure()}>{(why) => <p class="field-error">{why()}</p>}</Show>
        <p class="field-hint">
          Run <code>sova token</code> on the machine Sova runs on to print it, or <code>sova open</code> to open an unlocked
          window there.
        </p>
        <button type="submit" class="button button-primary" disabled={busy() || !token().trim()}>
          Unlock
        </button>
      </form>
    </main>
  );
}

/** The app, or the unlock screen in its place once the server refuses this browser — from any
    state of the shell. While a `#t=` link's token is being posted, neither: the app would only
    collect refusals ahead of its cookie. */
export function AuthShell(props: { children: JSX.Element }) {
  return (
    <Switch fallback={props.children}>
      <Match when={authState() === "unlocking"}>{null}</Match>
      <Match when={authState() === "locked"}>
        <Unlock />
      </Match>
    </Switch>
  );
}
