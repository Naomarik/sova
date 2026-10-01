import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { mintAccessCode, revealAccessToken } from "../lib/api";
import { Icon } from "./ui";
import { announce } from "../lib/ui-state";

export function AccessPage() {
  const [pair, setPair] = createSignal<Awaited<ReturnType<typeof mintAccessCode>> | null>(null);
  const [minting, setMinting] = createSignal(false);
  const [mintError, setMintError] = createSignal(false);
  const [token, setToken] = createSignal<string | null>(null);
  const [revealing, setRevealing] = createSignal(false);
  const [tokenError, setTokenError] = createSignal(false);
  const [copyStatus, setCopyStatus] = createSignal("");
  const [now, setNow] = createSignal(Date.now());
  const timer = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(timer));
  const seconds = () => Math.max(0, Math.ceil((Date.parse(pair()?.expiresAt ?? "") - now()) / 1000));
  const remaining = () => `${Math.floor(seconds() / 60)}:${String(seconds() % 60).padStart(2, "0")} left`;
  const mintStatus = () => minting() ? "Making a code for your other device…" : mintError() ? "The code couldn't be made. Try making a code again." : pair() ? "Your code is ready. Keep the code and link private." : "No code made yet. Make one when your other device is ready.";
  const tokenStatus = () => token() ? "The install's token is visible. Keep it private." : tokenError() ? "The token couldn't be fetched. Try revealing it again, or run sova token on the machine Sova runs on." : revealing() ? "Fetching the install's token…" : "The token stays hidden until you choose to reveal it.";
  createEffect(() => announce([mintStatus(), copyStatus(), tokenStatus()].filter(Boolean).join(" ")));
  let title!: HTMLHeadingElement;
  onMount(() => title.focus());

  async function mint() {
    if (minting()) return;
    setMinting(true);
    setMintError(false);
    setCopyStatus("");
    try {
      setPair(await mintAccessCode());
      setNow(Date.now());
    } catch {
      setMintError(true);
    } finally {
      setMinting(false);
    }
  }

  async function reveal() {
    if (revealing()) return;
    setRevealing(true);
    setTokenError(false);
    try {
      setToken((await revealAccessToken()).token);
    } catch {
      setTokenError(true);
    } finally {
      setRevealing(false);
    }
  }

  async function copy() {
    const url = pair()?.url;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopyStatus("Link copied.");
    } catch {
      setCopyStatus("The link wasn't copied. Select it and copy it yourself.");
    }
  }

  return (
    <div class="pane" style={{ height: "100%", padding: "var(--space-5)", "box-sizing": "border-box" }}>
      <div class="stack stack-5" style={{ "max-width": "var(--measure)", margin: "0 auto" }}>
        <a class="button button-ghost" href="#/overview" style={{ "align-self": "flex-start" }}>
          <Icon name="chevron-left" /> Back to Overview
        </a>
        <h1 ref={title} tabindex="-1" class="text-display-xl" style={{ margin: "0" }}>Access</h1>
        <p>Bring a second device—your phone, for example—into Sova with a one-use code. You don't need to see or share this install's access token.</p>
        <section class="card stack" aria-labelledby="access-code-title" style={{ padding: "var(--space-4)", "min-width": "0" }}>
          <h2 id="access-code-title" class="text-heading-m">Bring a device in</h2>
          <p>The code expires in 5 minutes and works once. Open the link on the other device to unlock it.</p>
          <button class="button button-primary" type="button" disabled={minting()} onClick={mint} style={{ "align-self": "flex-start" }}>
            {minting() ? "Making Code…" : pair() ? "Make Another Code" : "Make a Code"}
          </button>
          <p>{mintStatus()}</p>
          <Show when={pair()}>{(p) => (
            <>
              <div class="field">
                <label class="field-label" for="access-code">Pairing code</label>
                <textarea id="access-code" class="textarea input-mono" readonly value={p().code} spellcheck={false} style={{ "font-size": "var(--fs-heading-m)", "overflow-wrap": "anywhere" }} />
              </div>
              <p class="text-mono">{seconds() ? remaining() : "This code has expired. Make another code."}</p>
              <div class="field">
                <label class="field-label" for="access-url">Link for the other device</label>
                <textarea id="access-url" class="textarea input-mono" readonly value={p().url} spellcheck={false} />
              </div>
              <button class="button" type="button" onClick={copy} disabled={!seconds()} style={{ "align-self": "flex-start" }}><Icon name="copy" /> Copy</button>
              <p>{copyStatus()}</p>
            </>
          )}</Show>
        </section>
        <section class="stack" aria-labelledby="access-recovery-title">
          <h2 id="access-recovery-title" class="text-heading-m">If the code path isn't working</h2>
          <p>The install's token is a long-lived credential with full access to Sova. A screenshot of it shares that access. Reveal it only if you need the fallback.</p>
          <Show when={token()} fallback={
            <button class="button button-ghost" type="button" disabled={revealing()} onClick={reveal} style={{ "align-self": "flex-start" }}>
              {revealing() ? "Revealing Token…" : "Reveal Install Token"}
            </button>
          }>{(t) => (
            <div class="field">
              <label class="field-label" for="access-token">Install token</label>
              <textarea id="access-token" class="textarea input-mono" readonly value={t()} spellcheck={false} />
            </div>
          )}</Show>
          <p>{tokenStatus()}</p>
        </section>
      </div>
    </div>
  );
}
