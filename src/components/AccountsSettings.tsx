import { createResource, createSignal, For, onCleanup, Show } from "solid-js";
import type { ClaudeAccountsInfo, ClaudeLoginFlowState, ClaudeLoginRow } from "../../shared/protocol";
import {
  cancelClaudeLogin,
  clearClaudeLogin,
  getClaudeAccounts,
  patchClaudeLogin,
  putClaudeLoginOrder,
  removeClaudeLogin,
  sendClaudeLoginCode,
  startClaudeLogin,
} from "../lib/api";
import { stampTime } from "../lib/format";
import { Banner, Chip } from "./ui";
import { RetryButton, sentence } from "./WorkerSlotRow";

/** What a row is called: its label, else its email, else what it is. */
function nameOf(l: ClaudeLoginRow): string {
  return l.label ?? l.identity?.email ?? (l.id === "default" ? "Claude Code's own login" : l.id);
}

/** Organization and plan, then where the login lives. */
function factsOf(l: ClaudeLoginRow): string {
  const facts = [l.label && l.identity?.email, l.identity?.orgName, l.identity?.planLabel].filter(Boolean) as string[];
  if (l.id === "default") facts.push("Claude Code's own directory");
  return facts.join(" · ");
}

const WINDOWS: Record<string, string> = { five_hour: "5h limit", seven_day: "Weekly limit", seven_day_opus: "Weekly Opus limit", seven_day_sonnet: "Weekly Sonnet limit" };

function Standing(props: { login: ClaudeLoginRow }) {
  const s = () => props.login.standing;
  return (
    <Show
      when={props.login.signedIn || props.login.id === "default"}
      fallback={<Chip tone="error">Not signed in</Chip>}
    >
      <Show when={s().state === "limited"}>
        <Chip tone="warn" title={WINDOWS[(s() as { window?: string }).window ?? ""] ?? "Usage limit"}>
          Limited until {stampTime((s() as { until: number }).until)}
        </Chip>
      </Show>
      <Show when={s().state === "auth"}>
        <Chip tone="error" title={(s() as { message?: string }).message}>
          Sign in again
        </Chip>
      </Show>
      <Show when={s().state === "ready"}>
        <Show when={props.login.enabled} fallback={<Chip>Off</Chip>}>
          <Chip tone="success">Ready</Chip>
        </Show>
      </Show>
    </Show>
  );
}

/**
 * Settings → Accounts (§app.claude-logins): this device's Claude logins in the order every Claude
 * process tries them, and adding one through Claude Code's own sign-in. Every change saves at once.
 */
export function AccountsSettingsSection() {
  const [info, { mutate, refetch }] = createResource(getClaudeAccounts);
  const loaded = () => (info.error ? undefined : info());
  const [busy, setBusy] = createSignal<string | null>(null);
  const [actionError, setActionError] = createSignal<string | null>(null);
  const [confirmRemove, setConfirmRemove] = createSignal<string | null>(null);

  const run = async (what: string, fn: () => Promise<ClaudeAccountsInfo>) => {
    setBusy(what);
    setActionError(null);
    try {
      mutate(await fn());
    } catch (err) {
      setActionError(sentence(err instanceof Error ? err.message : String(err)));
      void refetch();
    } finally {
      setBusy(null);
    }
  };

  const move = (i: number, by: -1 | 1) => {
    const ids = loaded()!.logins.map((l) => l.id);
    const j = i + by;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    void run(`move-${ids[j]}`, () => putClaudeLoginOrder(ids));
  };

  /** The other rows of the same account, by name: they share its usage limits. */
  const sameAccount = (l: ClaudeLoginRow) => {
    const uuid = l.identity?.accountUuid;
    if (!uuid) return [];
    return loaded()!.logins.filter((o) => o.id !== l.id && o.identity?.accountUuid === uuid).map(nameOf);
  };

  // -- the add-login flow --
  const [flow, setFlow] = createSignal<ClaudeLoginFlowState | null>(null);
  const [code, setCode] = createSignal("");
  const [copied, setCopied] = createSignal(false);
  const flowOpen = () => {
    const f = flow();
    return !!f && f.state !== "done" && f.state !== "failed";
  };
  const startFlow = async () => {
    setActionError(null);
    setCode("");
    setFlow({ state: "starting" });
    try {
      setFlow(await startClaudeLogin());
    } catch (err) {
      setFlow({ state: "failed", error: sentence(err instanceof Error ? err.message : String(err)) });
    }
    void refetch();
  };
  const finishFlow = async () => {
    const c = code().trim();
    if (!c) return;
    setFlow({ state: "finishing" });
    try {
      const next = await sendClaudeLoginCode(c);
      setFlow(next);
      if (next.state === "done") setCode("");
    } catch (err) {
      setFlow({ state: "failed", error: sentence(err instanceof Error ? err.message : String(err)) });
    }
    void refetch();
  };
  const cancelFlow = async () => {
    setFlow(null);
    setCode("");
    try {
      mutate(await cancelClaudeLogin());
    } catch {
      void refetch();
    }
  };
  // Closing Settings mid-sign-in leaves no Claude Code process waiting for a code.
  onCleanup(() => {
    if (flowOpen()) void cancelClaudeLogin().catch(() => {});
  });
  const copyUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* the link is still there to open */
    }
  };

  return (
    <section class="settings-delegate accounts-settings" aria-labelledby="settings-accounts-title">
      <div class="settings-type-head">
        <h3 class="settings-type-title" id="settings-accounts-title">
          Claude Logins
        </h3>
      </div>
      <p class="settings-intro">
        Every Claude process on <Show when={loaded()} fallback="this device">{(i) => <strong>{i().device.label}</strong>}</Show> runs on the first
        ready login in this order. When one hits a usage limit or its sign-in fails, the work moves to the next.
      </p>

      <Show when={info.error}>
        <Banner
          tone="error"
          title="Couldn't load the Claude logins."
          body={sentence(info.error instanceof Error ? info.error.message : String(info.error))}
          action={<RetryButton label="Try Again" onClick={() => void refetch()} />}
        />
      </Show>

      <Show when={loaded()}>
        {(i) => (
          <>
            <Show when={i().error}>
              {(e) => <Banner tone="error" title="The Claude accounts file can't be read, so every Claude process uses Claude Code's own login." body={e()} />}
            </Show>
            <ol class="accounts-logins" data-testid="claude-logins">
              <For each={i().logins}>
                {(l, idx) => (
                  <li class="accounts-login" data-login={l.id}>
                    <div class="accounts-login-text">
                      <span class="accounts-login-name">{nameOf(l)}</span>
                      <span class="accounts-login-fact">{factsOf(l)}</span>
                      <Show when={sameAccount(l).length > 0}>
                        <span class="accounts-login-fact">Same account as {sameAccount(l).join(", ")}: shares its usage limits.</span>
                      </Show>
                    </div>
                    <Standing login={l} />
                    <div class="accounts-login-actions">
                      <button
                        type="button"
                        class="button button-sm button-ghost"
                        aria-label={`Move ${nameOf(l)} up`}
                        disabled={!!busy() || idx() === 0}
                        onClick={() => move(idx(), -1)}
                      >
                        Up
                      </button>
                      <button
                        type="button"
                        class="button button-sm button-ghost"
                        aria-label={`Move ${nameOf(l)} down`}
                        disabled={!!busy() || idx() === i().logins.length - 1}
                        onClick={() => move(idx(), 1)}
                      >
                        Down
                      </button>
                      <label class="toggle toggle-switch accounts-login-toggle">
                        <span>Use</span>
                        <input
                          type="checkbox"
                          checked={l.enabled}
                          disabled={!!busy()}
                          aria-label={`Use ${nameOf(l)}`}
                          onChange={(e) => void run(`enable-${l.id}`, () => patchClaudeLogin(l.id, { enabled: e.currentTarget.checked }))}
                        />
                        <span class="toggle-box" />
                      </label>
                      <Show when={l.standing.state !== "ready"}>
                        <button type="button" class="button button-sm" disabled={!!busy()} onClick={() => void run(`clear-${l.id}`, () => clearClaudeLogin(l.id))}>
                          Clear
                        </button>
                      </Show>
                      <Show when={l.id !== "default"}>
                        <button
                          type="button"
                          class="button button-sm button-destructive"
                          aria-label={`Remove ${nameOf(l)}`}
                          disabled={!!busy()}
                          onClick={() => setConfirmRemove(l.id)}
                        >
                          Remove
                        </button>
                      </Show>
                    </div>
                    <Show when={confirmRemove() === l.id}>
                      <div class="accounts-login-confirm" role="group" aria-label={`Remove ${nameOf(l)}`}>
                        <p class="field-hint">
                          Sova signs {nameOf(l)} out of Claude Code and deletes its directory. Its sessions' transcripts stay; work on it moves
                          to the next login.
                        </p>
                        <span class="button-row">
                          <button type="button" class="button button-sm button-ghost" onClick={() => setConfirmRemove(null)}>
                            Cancel
                          </button>
                          <button
                            type="button"
                            class="button button-sm button-destructive"
                            disabled={!!busy()}
                            onClick={() => {
                              setConfirmRemove(null);
                              void run(`remove-${l.id}`, () => removeClaudeLogin(l.id));
                            }}
                          >
                            Remove Login
                          </button>
                        </span>
                      </div>
                    </Show>
                  </li>
                )}
              </For>
            </ol>
            <Show when={i().elsewhere.length > 0}>
              <p class="field-hint">
                {i().elsewhere.length} other {i().elsewhere.length === 1 ? "login belongs" : "logins belong"} to another device and{" "}
                {i().elsewhere.length === 1 ? "isn't" : "aren't"} used here.
              </p>
            </Show>
            <Show when={actionError()}>{(e) => <p class="field-error">{e()}</p>}</Show>

            <fieldset class="settings-delegate-profile accounts-add">
              <legend class="settings-delegate-legend">Add a login</legend>
              <Show
                when={flow()}
                fallback={
                  <>
                    <p class="field-hint">Sign in to another Claude subscription. Claude Code keeps its sign-in in its own directory on this device.</p>
                    <button type="button" class="button button-sm button-primary" disabled={!!busy() || !!i().error} onClick={() => void startFlow()}>
                      Add Login
                    </button>
                  </>
                }
              >
                {(f) => (
                  <div class="accounts-flow" aria-live="polite">
                    <Show when={f().state === "starting"}>
                      <p class="field-hint">Starting Claude Code's sign-in…</p>
                    </Show>
                    <Show when={f().state === "waiting" || f().state === "finishing"}>
                      {(() => {
                        const url = () => (f() as { url?: string }).url ?? (flow() as { url?: string } | null)?.url ?? "";
                        return (
                          <>
                            <p class="field-hint">Open this link in any browser, sign in, then paste the code the page shows.</p>
                            <Show when={url()}>
                              <p class="accounts-flow-url">
                                <a href={url()} target="_blank" rel="noopener noreferrer" class="text-mono">
                                  {url()}
                                </a>
                                <button type="button" class="button button-sm button-ghost" onClick={() => void copyUrl(url())}>
                                  {copied() ? "Copied" : "Copy Link"}
                                </button>
                              </p>
                            </Show>
                            <label class="field">
                              <span class="field-label">Code</span>
                              <input
                                class="input input-mono"
                                value={code()}
                                autocomplete="off"
                                spellcheck={false}
                                disabled={f().state === "finishing"}
                                onInput={(e) => setCode(e.currentTarget.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") void finishFlow();
                                }}
                              />
                            </label>
                            <Show when={(f() as { error?: string }).error}>{(e) => <p class="field-error">{e()}</p>}</Show>
                            <span class="button-row">
                              <button type="button" class="button button-sm button-ghost" onClick={() => void cancelFlow()}>
                                Cancel
                              </button>
                              <button
                                type="button"
                                class="button button-sm button-primary"
                                disabled={!code().trim() || f().state === "finishing"}
                                onClick={() => void finishFlow()}
                              >
                                {f().state === "finishing" ? "Signing In…" : "Finish Sign-In"}
                              </button>
                            </span>
                          </>
                        );
                      })()}
                    </Show>
                    <Show when={f().state === "done"}>
                      {(() => {
                        const done = f() as Extract<ClaudeLoginFlowState, { state: "done" }>;
                        return (
                          <>
                            <p class="push-status">
                              <Chip tone="success">Added</Chip>
                              <span>
                                {nameOf(done.login)}
                                {factsOf(done.login) ? ` · ${factsOf(done.login)}` : ""}
                              </span>
                            </p>
                            <Show when={done.sharedAccount}>
                              <p class="field-hint">
                                This account is already here, so the two share usage limits: the new login only helps when the other one's sign-in fails.
                              </p>
                            </Show>
                            <button type="button" class="button button-sm" onClick={() => setFlow(null)}>
                              Done
                            </button>
                          </>
                        );
                      })()}
                    </Show>
                    <Show when={f().state === "failed"}>
                      <p class="field-error">{sentence((f() as { error: string }).error)} Nothing was added.</p>
                      <span class="button-row">
                        <button type="button" class="button button-sm button-ghost" onClick={() => setFlow(null)}>
                          Close
                        </button>
                        <button type="button" class="button button-sm" onClick={() => void startFlow()}>
                          Try Again
                        </button>
                      </span>
                    </Show>
                  </div>
                )}
              </Show>
            </fieldset>
          </>
        )}
      </Show>
    </section>
  );
}
