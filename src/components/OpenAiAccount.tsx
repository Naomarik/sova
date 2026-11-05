import { createEffect, createResource, createSignal, onCleanup, Show } from "solid-js";
import { cancelOpenAiLogin, fetchUsage, getOpenAiAccount, getOpenAiLogin, sendOpenAiLoginAnswer, signOutOpenAi, startOpenAiLogin } from "../lib/api";
import { loadModels } from "../lib/models";
import { EXPIRED_TEXT, failedText, flowOpen, type OpenAiAccountInfo, type OpenAiLoginFlow, sectionNote, signedInFacts, signOutText, standingOf } from "../lib/openai-login";
import { TextField } from "./form";
import { Banner, Chip } from "./ui";
import { RetryButton, sentence } from "./WorkerSlotRow";

const message = (err: unknown) => sentence(err instanceof Error ? err.message : String(err));
const POLL_MS = 2000;
const USAGE_TRIES = 6;
const USAGE_TRY_MS = 2500;

/**
 * Settings → Accounts, below the Claude logins (§app.openai-login/section): this device's one
 * OpenAI sign-in (a ChatGPT subscription, pi's `openai-codex`), and the sign-in panel
 * (§app.openai-login/sign-in): the code route first, the browser route when OpenAI refuses it.
 */
export function OpenAiAccountSection() {
  const [info, { mutate, refetch }] = createResource(getOpenAiAccount);
  const loaded = () => (info.error ? undefined : info());
  /** OpenAI's latest usage reading: its plan, and whether the sign-in stopped working. */
  const readUsage = () => fetchUsage().then((u) => u.providers.find((p) => p.id === "openai")).catch(() => undefined);
  const [usage, { mutate: setUsage }] = createResource(readUsage);
  /**
   * After a sign-in the server asks for a usage reading but answers before it lands, so read it
   * again until it no longer says "not signed in" (a few tries, then the next open of the tab).
   */
  let usageTry: ReturnType<typeof setTimeout> | undefined;
  const followUsage = (left = USAGE_TRIES) => {
    if (usageTry) clearTimeout(usageTry);
    usageTry = setTimeout(async () => {
      const p = await readUsage();
      if (p) setUsage(p);
      if (left > 1 && (!p || p.state === "nologin")) followUsage(left - 1);
    }, USAGE_TRY_MS);
  };
  onCleanup(() => usageTry && clearTimeout(usageTry));
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
      followUsage();
    }
  };

  // While the code or browser step waits, read the flow until it moves on.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopPoll = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  // The server's own `finishing` (OpenAI called back by itself, pi swapping the code) is polled
  // too, until done or failed; not while this tab's own answer is in flight (its reply settles it).
  const [answering, setAnswering] = createSignal(false);
  createEffect(() => {
    const f = flow();
    stopPoll();
    if (!f || answering() || (f.state !== "code" && f.state !== "browser" && f.state !== "finishing")) return;
    timer = setTimeout(async () => {
      try {
        const next = await getOpenAiLogin();
        // Moved on meanwhile (cancelled, answered, settled): this reading is stale.
        if (flow() !== f || answering()) return;
        if (!next) settle({ state: "failed", error: "The sign-in ended." });
        else if (next.state === "browser" && f.state === "browser") setFlow({ ...next, ...(f.error && !next.error ? { error: f.error } : {}) }); // still waiting: poll again
        else if (next.state === f.state) setFlow({ ...next }); // same step: poll again
        else settle(next);
      } catch {
        if (flow() === f) setFlow({ ...f });
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
    setAnswering(true);
    setFlow({ state: "finishing" });
    try {
      const next = await sendOpenAiLoginAnswer(text);
      if (next.state === "done") setAnswer("");
      if (flow()) settle(next); // not cancelled meanwhile
    } catch (err) {
      // A refused address keeps the step waiting, with the reason.
      if (flow()) setFlow({ ...f, error: message(err) });
    } finally {
      setAnswering(false);
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
  /** `label`: a long link (the browser route's authorize address) reads as words; Copy Link still copies it whole. */
  const Link = (props: { url: string; label?: string }) => (
    <p class="accounts-flow-url">
      <a href={props.url} target="_blank" rel="noopener noreferrer" class={props.label ? undefined : "text-mono"}>
        {props.label ?? props.url}
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
                          <Link url={b().url} label="Open OpenAI's sign-in page" />
                          <TextField
                            label="Address after signing in"
                            inputClass="input-mono"
                            value={answer()}
                            autocomplete="off"
                            spellcheck={false}
                            placeholder="http://localhost:1455/auth/callback?code=…"
                            error={b().error ? sentence(b().error!) : null}
                            onInput={setAnswer}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") void finish();
                            }}
                          />
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
                      <span class="button-row">
                        <CancelButton />
                      </span>
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
