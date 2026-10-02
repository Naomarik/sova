import { createSignal, Match, Show, Switch, type JSX } from "solid-js";
import { authState, unlock, unlockFailure } from "../lib/auth";

type Kind = "code" | "token";

/**
 * The unlock screen: what a browser without the token sees instead of the app.
 * It makes no request until the button is pressed, so it renders whatever the server would refuse.
 * The person says what they are pasting — a code and a token are the same shape and cannot be told
 * apart by looking — so the choice is a visible one, not a guess. It defaults to the token, the
 * recovery path that always works; the code is the shorter road when another browser is already in.
 */
export function Unlock() {
  const [token, setToken] = createSignal("");
  const [kind, setKind] = createSignal<Kind>("token");
  const [busy, setBusy] = createSignal(false);

  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    if (busy() || !token().trim()) return;
    setBusy(true);
    // A page unlocked by hand starts over, so nothing it fetched while refused is kept.
    if ((await unlock(token(), undefined, kind())) === "ok") location.reload();
    else setBusy(false);
  };

  return (
    // The window's height, as the shell's: the document itself never scrolls.
    <main class="empty" style={{ height: "100%", "box-sizing": "border-box", "overflow-y": "auto", "justify-content": "center" }}>
      <h1 class="empty-title">Unlock Sova</h1>
      <p class="empty-body">This browser hasn't been let into this Sova yet.</p>
      <p class="empty-body">
        A pairing code is the way in: on any browser that's already in, open Access to make a code, then open
        this address with <code>#c=&lt;code&gt;</code> after it, or paste the code here.
      </p>
      <form class="field empty-action" style={{ width: "min(100%, 28rem)", "text-align": "left" }} onSubmit={submit}>
        <fieldset class="field unlock-route">
          <legend class="field-label">What are you pasting?</legend>
          <label class="toggle unlock-choice">
            <input type="radio" name="unlock-kind" checked={kind() === "code"} onChange={() => setKind("code")} />
            <span class="toggle-box" aria-hidden="true" />
            <span class="unlock-choice-main">
              <span class="unlock-choice-name">Pairing code</span>
              <span class="unlock-choice-meta">Made in Access on a browser that's already in. Works once, for 5 minutes.</span>
            </span>
          </label>
          <label class="toggle unlock-choice">
            <input type="radio" name="unlock-kind" checked={kind() === "token"} onChange={() => setKind("token")} />
            <span class="toggle-box" aria-hidden="true" />
            <span class="unlock-choice-main">
              <span class="unlock-choice-name">Access token</span>
              <span class="unlock-choice-meta">This install's long-lived credential, from its token file.</span>
            </span>
          </label>
        </fieldset>
        <label class="field-label" for="unlock-token">
          {kind() === "token" ? "Access token" : "Pairing code"}
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
          {kind() === "token"
            ? <>The token file is on the machine Sova runs on: <code>~/.pi/agent/sova/auth-token</code>, or <code>sova/auth-token</code> under the server's <code>PI_CODING_AGENT_DIR</code>. With the installer's launcher, <code>sova token</code> prints it and <code>sova open</code> opens an unlocked window there.</>
            : "Paste it whole, exactly as Access shows it."}
        </p>
        <button type="submit" class="button button-primary" disabled={busy() || !token().trim()}>
          Unlock
        </button>
      </form>
      <p class="empty-body">
        Unlocking covers this address only: <code>127.0.0.1</code>, <code>localhost</code> and a tailnet name each
        need their own, while two ports of one host share one.
      </p>
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
