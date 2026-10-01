import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { mintAccessCode, revealAccessToken } from "../lib/api";
import { Icon } from "./ui";
import { announce } from "../lib/ui-state";
import { encodeQr } from "../lib/qr";

function reachableLink(url: string): boolean {
  try {
    const { hostname, protocol } = new URL(url);
    return ["http:", "https:"].includes(protocol) && !/^(localhost|.*\.localhost|127(?:\.\d+){3}|\[::1\]|0\.0\.0\.0)$/i.test(hostname);
  } catch { return false; }
}

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
  const links = createMemo(() => pair()?.links ?? []);
  const firstLink = createMemo(() => links()[0]);
  const phoneLink = createMemo(() => {
    const link = firstLink();
    return link && reachableLink(link.url) ? link : undefined;
  });
  const qr = createMemo(() => {
    const link = phoneLink();
    if (!link) return null;
    try {
      const encoded = encodeQr(link.url);
      // Keep modules large enough to scan at the fixed display size.
      if (encoded.version > 10) return null;
      const path = encoded.matrix.flatMap((row, y) => row.flatMap((dark, x) => dark ? [`M${x + 4},${y + 4}h1v1h-1z`] : [])).join("");
      return { path, size: encoded.matrix.length + 8 };
    } catch { return null; }
  });
  const remaining = () => `${Math.floor(seconds() / 60)}:${String(seconds() % 60).padStart(2, "0")} left`;
  const mintStatus = () => minting() ? "Making a code for your other device…" : mintError() ? "The code couldn't be made. Try making a code again." : pair() ? "Your code is ready. Keep the code and link private." : "No code made yet. Make one when your other device is ready.";
  const tokenStatus = () => token() ? "The install's token is visible. Keep it private." : tokenError() ? "The token couldn't be fetched. Try revealing it again, or read the token file on the machine Sova runs on: ~/.pi/agent/sova/auth-token (sova/auth-token under the server's PI_CODING_AGENT_DIR)." : revealing() ? "Fetching the install's token…" : "The token stays hidden until you choose to reveal it.";
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

  async function copy(url: string) {
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
        <p>Let another browser or device into this Sova — a different browser or address on this machine, or your phone — with a one-use code. You never see or share this install's access token.</p>
        <section class="card stack" aria-labelledby="access-code-title" style={{ padding: "var(--space-4)", "min-width": "0" }}>
          <h2 id="access-code-title" class="text-heading-m">Bring a device in</h2>
          <p>The code expires in 5 minutes and works once. Scan the QR or open a link on the browser or device you're letting in, or type the code on its unlock screen. Each link is an address of this Sova with <code>/#c=&lt;code&gt;</code> after it; the code works at any of them.</p>
          <button class="button button-primary" type="button" disabled={minting()} onClick={mint} style={{ "align-self": "flex-start" }}>
            {minting() ? "Making Code…" : pair() ? "Make Another Code" : "Make a Code"}
          </button>
          <p>{mintStatus()}</p>
          <Show when={pair()}>{(p) => (
            <>
              <div style={{ display: "flex", "flex-wrap": "wrap", gap: "var(--space-4)", "align-items": "flex-start" }}>
              <div class="stack stack-2" style={{ "flex-basis": "calc(var(--space-8) * 4)", "max-width": "100%" }}>
              <Show when={phoneLink()} fallback={
                <p>Sova has to be reached by its tailnet address for a phone to pair. Open Sova at that address, then make another code.</p>
              }>
                <Show when={seconds()}>
                  <Show when={qr()} fallback={<p>This link is too long for an easy-to-scan QR. Copy the link to your other device instead.</p>}>{(q) => (
                    <>
                    <svg role="img" aria-label="QR code to pair your other device with Sova" viewBox={`0 0 ${q().size} ${q().size}`} shape-rendering="crispEdges"
                      style={{ width: "calc(var(--space-8) * 4)", "max-width": "100%", height: "auto", "align-self": "flex-start", color: "light-dark(var(--color-ink), var(--color-surface))" }}>
                      <rect width={q().size} height={q().size} fill="light-dark(var(--color-surface), var(--color-ink))" />
                      <path d={q().path} fill="currentColor" />
                    </svg>
                    <p>Scan with your phone's camera. Keep this QR and its link private.</p>
                    </>
                  )}</Show>
                </Show>
              </Show>
              </div>
              <div class="stack" style={{ flex: "1 1 calc(var(--space-8) * 4)", "min-width": "0" }}>
                <div class="field">
                  <label class="field-label" for="access-code">Pairing code</label>
                  <textarea id="access-code" class="textarea input-mono" readonly value={p().code} spellcheck={false} style={{ "font-size": "var(--fs-heading-m)", "overflow-wrap": "anywhere" }} />
                </div>
                <p class="text-mono">{seconds() ? remaining() : "This code has expired. Make another code."}</p>
              <For each={links()}>{(link, index) => (
                <div class="stack stack-2">
                  <div class="field">
                    <label class="field-label" for={`access-url-${index()}`}>{link.label}</label>
                    <textarea id={`access-url-${index()}`} class="textarea input-mono" readonly value={link.url} spellcheck={false} />
                  </div>
                  <button class="button" type="button" aria-label={`Copy ${link.label} Link`} onClick={() => copy(link.url)} disabled={!seconds()} style={{ "align-self": "flex-start" }}><Icon name="copy" /> Copy Link</button>
                </div>
              )}</For>
              </div>
              </div>
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
