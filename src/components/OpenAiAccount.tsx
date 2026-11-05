import { createEffect, createResource, createSignal, onCleanup, Show } from "solid-js";
import { cancelOpenAiLogin, fetchUsage, getOpenAiAccount, getOpenAiLogin, sendOpenAiLoginAnswer, signOutOpenAi, startOpenAiLogin } from "../lib/api";
import { loadModels } from "../lib/models";
import { EXPIRED_TEXT, failedText, flowOpen, type OpenAiAccountInfo, type OpenAiLoginFlow, sectionNote, signedInFacts, signOutText, standingOf } from "../lib/openai-login";
import { Banner, Chip } from "./ui";
import { RetryButton, sentence } from "./WorkerSlotRow";

const message = (err: unknown) => sentence(err instanceof Error ? err.message : String(err));
const POLL_MS = 2000;

/**
 * Settings → Accounts, below the Claude logins (§app.openai-login/section): this device's one
 * OpenAI sign-in (a ChatGPT subscription, pi's `openai-codex`), and the sign-in panel
 * (§app.openai-login/sign-in): the code route first, the browser route when OpenAI refuses it.
 */
export function OpenAiAccountSection() {
  const [info, { mutate, refetch }] = createResource(getOpenAiAccount);
  const loaded = () => (info.error ? undefined : info());
  /** OpenAI's latest usage reading: its plan, and whether the sign-in stopped working. */
  const [usage, { refetch: refetchUsage }] = createResource(() => fetchUsage().then((u) => u.providers.find((p) => p.id === "openai")).catch(() => undefined));
  const reading = () => (usage.error ? undefined : usage());
  const [flow, setFlow] = createSignal<OpenAiLoginFlow | null>(null);
  const [answer, setAnswer] = createSignal("");
  const [copied, setCopied] = createSignal(false);
  const [confirm, setConfirm] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [actionError, setActionError] = createSignal<string | null>(null);

  // A sign-in already running when the tab opens (another tab started it) shows its step.
  createEffect(() => {
    const f = loaded()?.flow;
    if (f && flowOpen(f) && !flow()) setFlow(f);
  });

  /** A finished sign-in: show its step and read the section again. */
  const settle = (next: OpenAiLoginFlow | null) => {
    setFlow(next);
    if (flowOpen(next)) return;
    void refetch();
    if (next?.state === "done") {
      // The ChatGPT models join the model menu, and the usage reading names the plan.
      void loadModels().catch(() => {});
      void refetchUsage();
    }
  };

  // While the code or browser step waits, read the flow until it moves on.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopPoll = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  createEffect(() => {
    const f = flow();
    stopPoll();
    if (!f || (f.state !== "code" && f.state !== "browser")) return;
    timer = setTimeout(async () => {
      try {
        const next = await getOpenAiLogin();
        // Cancelled meanwhile (flow cleared here): ignore the answer.
        if (!flow()) return;
        if (!next) settle({ state: "failed", error: "The sign-in ended." });
        else if (next.state === "browser" && f.state === "browser") setFlow({ ...next, ...(f.error && !next.error ? { error: f.error } : {}) }); // still waiting: poll again
        else if (next.state === f.state && next.state === "code") setFlow({ ...next });
        else settle(next);
      } catch {
        setFlow({ ...f });
      }
    }, POLL_MS);
  });

  const start = async () => {
    setActionError(null);
    setConfirm(false);
    setAnswer("");
    setFlow({ state: "starting" });
    try {
      settle(await startOpenAiLogin());
    } catch (err) {
      settle({ state: "failed", error: message(err) });
    }
  };
  const finish = async () => {
    const text = answer().trim();
    const f = flow();
    if (!text || f?.state !== "browser") return;
    setFlow({ state: "finishing" });
    try {
      const next = await sendOpenAiLoginAnswer(text);
      if (next.state === "done") setAnswer("");
      settle(next);
    } catch (err) {
      // A refused address keeps the step waiting, with the reason.
      setFlow({ ...f, error: message(err) });
    }
  };
  const cancel = async () => {
    stopPoll();
    setFlow(null);
    setAnswer("");
    try {
      mutate(await cancelOpenAiLogin());
    } catch {
      void refetch();
    }
  };
  // Closing Settings mid-sign-in stops pi's sign-in (and frees localhost:1455 on the browser route).
  onCleanup(() => {
    stopPoll();
    if (flowOpen(flow())) void cancelOpenAiLogin().catch(() => {});
  });

  const signOut = async () => {
    setConfirm(false);
    setBusy(true);
    setActionError(null);
    try {
      mutate(await signOutOpenAi());
      void loadModels().catch(() => {});
    } catch (err) {
      setActionError(message(err));
      void refetch();
    } finally {
      setBusy(false);
    }
  };

  const copyUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* the link is still there to open */
    }
  };
  const Link = (props: { url: string }) => (
    <p class="accounts-flow-url">
      <a href={props.url} target="_blank" rel="noopener noreferrer" class="text-mono">
        {props.url}
      </a>
      <button type="button" class="button button-sm button-ghost" onClick={() => void copyUrl(props.url)}>
        {copied() ? "Copied" : "Copy Link"}
      </button>
    </p>
  );
  const CancelButton = () => (
    <button type="button" class="button button-sm button-ghost" onClick={() => void cancel()}>
      Cancel
    </button>
  );

  const Status = (props: { i: OpenAiAccountInfo }) => {
    const standing = () => standingOf(props.i, reading());
    return (
    <ol class="accounts-logins">
      <li class="accounts-login" data-login="openai-codex">
        <div class="accounts-login-text">
          <span class="accounts-login-name">{(props.i.signedIn && props.i.email) || "ChatGPT subscription"}</span>
          <Show when={standing() === "signed-in"}>
            <Facts items={signedInFacts(props.i, reading())} />
          </Show>
          <Show when={sectionNote(props.i)}>{(n) => <span class="accounts-login-fact">{n()}</span>}</Show>
        </div>
        <span class="accounts-login-chips">
          <Show when={standing() === "signed-out"}>
            <Chip>Not signed in</Chip>
          </Show>
          <Show when={standing() === "signed-in"}>
            <Chip tone="success">Signed in</Chip>
          </Show>
          <Show when={standing() === "sign-in-again"}>
            <Chip tone="error">Sign in again</Chip>
          </Show>
        </span>
        <div class="accounts-login-actions">
          <Show when={!flow()}>
            <Show
              when={standing() === "signed-in"}
              fallback={
                <button type="button" class="button button-sm button-primary" disabled={busy()} onClick={() => void start()}>
                  Sign In
                </button>
              }
            >
              <button type="button" class="button button-sm button-destructive" disabled={busy()} onClick={() => setConfirm(true)}>
                Sign Out
              </button>
            </Show>
          </Show>
        </div>
        <Show when={confirm()}>
          <div class="accounts-login-confirm" role="group" aria-label="Sign out of OpenAI">
            <p class="field-hint">{signOutText(props.i)}</p>
            <span class="button-row">
              <button type="button" class="button button-sm button-ghost" onClick={() => setConfirm(false)}>
                Cancel
              </button>
              <button type="button" class="button button-sm button-destructive" disabled={busy()} onClick={() => void signOut()}>
                Sign Out of OpenAI
              </button>
            </span>
          </div>
        </Show>
      </li>
    </ol>
    );
  };

  return (
    <section class="settings-delegate accounts-settings" aria-labelledby="settings-openai-title" data-testid="openai-account">
      <div class="settings-type-head">
        <h3 class="settings-type-title" id="settings-openai-title">
          OpenAI
        </h3>
      </div>
      <p class="settings-intro">Sova's chats use OpenAI's models through your ChatGPT subscription. Sign in once on this device; chats pick it up on their next message.</p>

      <Show when={info.error}>
        <Banner tone="error" title="Couldn't load the OpenAI sign-in." body={message(info.error)} action={<RetryButton label="Try Again" onClick={() => void refetch()} />} />
      </Show>

      <Show when={loaded()}>
        {(i) => (
          <>
            <Status i={i()} />
            <Show when={actionError()}>{(e) => <p class="field-error">{e()}</p>}</Show>
            <Show when={flow()}>
              {(f) => (
                <fieldset class="settings-delegate-profile accounts-add" data-testid="openai-sign-in">
                  <legend class="settings-delegate-legend">Sign in to OpenAI</legend>
                  <div class="accounts-flow" aria-live="polite">
                    <Show when={f().state === "starting"}>
                      <p class="field-hint">Starting OpenAI's sign-in…</p>
                      <span class="button-row">
                        <CancelButton />
                      </span>
                    </Show>
                    <Show when={f().state === "code" ? (f() as Extract<OpenAiLoginFlow, { state: "code" }>) : null}>
                      {(c) => (
                        <>
                          <p class="field-hint">Open this link on any device, sign in, and enter this code.</p>
                          <p class="accounts-flow-code text-mono" aria-label="Sign-in code">
                            {c().userCode}
                          </p>
                          <Link url={c().url} />
                          <p class="field-hint">We'll finish here once OpenAI accepts the code.</p>
                          <span class="button-row">
                            <CancelButton />
                          </span>
                        </>
                      )}
                    </Show>
                    <Show when={f().state === "browser" ? (f() as Extract<OpenAiLoginFlow, { state: "browser" }>) : null}>
                      {(b) => (
                        <>
                          <Show when={b().refused}>{(r) => <p class="field-hint">{sentence(r())}</p>}</Show>
                          <p class="field-hint">Open this link, sign in, then paste the address the page ends on.</p>
                          <Link url={b().url} />
                          <label class="field">
                            <span class="field-label">Address after signing in</span>
                            <input
                              class="input input-mono"
                              value={answer()}
                              autocomplete="off"
                              spellcheck={false}
                              placeholder="http://localhost:1455/auth/callback?code=…"
                              onInput={(e) => setAnswer(e.currentTarget.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") void finish();
                              }}
                            />
                          </label>
                          <Show when={b().error}>{(e) => <p class="field-error">{sentence(e())}</p>}</Show>
                          <span class="button-row">
                            <CancelButton />
                            <button type="button" class="button button-sm button-primary" disabled={!answer().trim()} onClick={() => void finish()}>
                              Finish Sign-In
                            </button>
                          </span>
                        </>
                      )}
                    </Show>
                    <Show when={f().state === "finishing"}>
                      <p class="field-hint">Signing in…</p>
                    </Show>
                    <Show when={f().state === "done" ? (f() as Extract<OpenAiLoginFlow, { state: "done" }>) : null}>
                      {(d) => (
                        <>
                          <p class="push-status">
                            <Chip tone="success">Signed in</Chip>
                            <Show when={d().email}>{(e) => <span>{e()}</span>}</Show>
                          </p>
                          <span class="button-row">
                            <button type="button" class="button button-sm" onClick={() => setFlow(null)}>
                              Done
                            </button>
                          </span>
                        </>
                      )}
                    </Show>
                    <Show when={f().state === "expired"}>
                      <p class="field-error">{EXPIRED_TEXT}</p>
                      <span class="button-row">
                        <button type="button" class="button button-sm button-ghost" onClick={() => setFlow(null)}>
                          Close
                        </button>
                        <button type="button" class="button button-sm" onClick={() => void start()}>
                          Try Again
                        </button>
                      </span>
                    </Show>
                    <Show when={f().state === "failed" ? (f() as Extract<OpenAiLoginFlow, { state: "failed" }>) : null}>
                      {(x) => (
                        <>
                          <p class="field-error">{failedText(sentence(x().error))}</p>
                          <span class="button-row">
                            <button type="button" class="button button-sm button-ghost" onClick={() => setFlow(null)}>
                              Close
                            </button>
                            <button type="button" class="button button-sm" onClick={() => void start()}>
                              Try Again
                            </button>
                          </span>
                        </>
                      )}
                    </Show>
                  </div>
                </fieldset>
              )}
            </Show>
          </>
        )}
      </Show>
    </section>
  );
}

/** The facts line under the email, joined by middots. */
function Facts(props: { items: string[] }) {
  return (
    <Show when={props.items.length}>
      <span class="accounts-login-fact">{props.items.join(" · ")}</span>
    </Show>
  );
}
