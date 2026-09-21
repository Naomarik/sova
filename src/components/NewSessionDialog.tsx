import { createEffect, createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { SessionSummary } from "../../shared/protocol";
import { ApiError, connectTarget, createSession, fetchTargets, listCwds } from "../lib/api";
import { tildePath } from "../lib/format";
import { localOnly, remoteLabel, type RemotePlace, remoteRecents, splitRemoteCwd, type TargetInfo, targetDown } from "../lib/remote-session";
import { home } from "../lib/ui-state";
import { FolderPicker } from "./FolderPicker";
import { Banner, Chip, Icon, trapFocus } from "./ui";

const MAX_RECENT = 20;
/** The targets list is a cached read on the server; past this it's broken, not slow. */
const TARGETS_TIMEOUT_MS = 10_000;
/** A probe still running when /api/targets answers reads "unknown" and finishes in the background:
    ask again this often, at most this many times, so "Not checked" settles into Reachable/Offline. */
const PROBE_RECHECK_MS = 6_000;
const PROBE_RECHECKS = 3;

type Where = "local" | "remote";
const TABS: { id: Where; label: string }[] = [
  { id: "local", label: "This Computer" },
  { id: "remote", label: "Remote" },
];

const targetName = (t: TargetInfo) => t.label || t.name;

/** The status chip of a target row: the server's last probe, in words. */
function TargetStatus(props: { target: TargetInfo; checking: boolean }) {
  return (
    <Show
      when={props.target.status === "ok"}
      fallback={
        <Show when={targetDown(props.target)} fallback={props.checking ? <Chip title="The server is still reaching it">Checking…</Chip> : <Chip title="Not checked yet">Not checked</Chip>}>
          <Chip tone="error" title={props.target.error}>
            Offline
          </Chip>
        </Show>
      }
    >
      <Chip tone="success">Reachable</Chip>
    </Show>
  );
}

/**
 * Asks for a folder, creates an empty webapp-owned session, and hands it back (spec/05-new-session-dialog.md §5).
 * The folder is chosen, never typed: the Folder field opens the folder picker in place. The Remote
 * tab does the same on a configured target, and can start the agent that connects a new one.
 */
export function NewSessionDialog(props: {
  prefill: string;
  /** Folders already used by sessions; the suggestions if /api/cwds is unavailable. */
  knownCwds: string[];
  onCreated(s: SessionSummary): void;
  onCancel(): void;
}) {
  const prefillRemote = splitRemoteCwd(props.prefill);
  const [cwds] = createResource(() => listCwds().catch(() => props.knownCwds));
  const [where, setWhere] = createSignal<Where>(prefillRemote ? "remote" : "local");
  const [cwd, setCwd] = createSignal(prefillRemote ? "" : props.prefill);
  const [place, setPlace] = createSignal<{ target: string | null; remoteCwd: string }>(
    prefillRemote ?? { target: null, remoteCwd: "" },
  );
  const [picking, setPicking] = createSignal(false);
  const [fieldError, setFieldError] = createSignal<string | null>(null);
  const [failed, setFailed] = createSignal(false);
  const [pending, setPending] = createSignal(false);
  const [connecting, setConnecting] = createSignal(false);
  const [connectError, setConnectError] = createSignal<string | null>(null);
  /** The Folder field of the tab that's shown (the Remote one exists once a target is chosen). */
  let field: HTMLButtonElement | undefined;
  let form!: HTMLFormElement;
  const tabEls: HTMLButtonElement[] = [];
  onMount(() => (field ?? tabEls[TABS.findIndex((t) => t.id === where())])?.focus());

  // Only fetched once the Remote tab is shown; bounded so "Loading targets…" always ends.
  const [targets, { refetch: refetchTargets }] = createResource(
    () => where() === "remote",
    () =>
      Promise.race([
        fetchTargets(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new ApiError(`No answer within ${TARGETS_TIMEOUT_MS / 1000}s.`, 504)), TARGETS_TIMEOUT_MS),
        ),
      ]),
  );
  const targetList = () => (targets.error ? [] : (targets() ?? []));
  const [rechecks, setRechecks] = createSignal(0);
  const checking = () => rechecks() < PROBE_RECHECKS;
  createEffect(() => {
    const list = targets();
    if (!list || targets.loading || !checking()) return;
    if (!list.some((t) => !t.status || t.status === "unknown")) return;
    const timer = setTimeout(() => {
      setRechecks((n) => n + 1);
      void refetchTargets();
    }, PROBE_RECHECK_MS);
    onCleanup(() => clearTimeout(timer));
  });
  const current = createMemo(() => {
    const name = place().target;
    return name ? (targetList().find((t) => t.name === name) ?? null) : null;
  });
  /** A target's display name, also for recents whose target is no longer configured. */
  const nameOf = (target: string) => {
    const t = targetList().find((x) => x.name === target);
    return t ? targetName(t) : target;
  };

  const recent = createMemo(() => localOnly(cwds() ?? []).slice(0, MAX_RECENT));
  const recentRemote = createMemo(() => remoteRecents(cwds() ?? []).slice(0, MAX_RECENT));
  const recentOnTarget = createMemo(() => {
    const t = place().target;
    return t ? remoteRecents(cwds() ?? [], t).map((p) => p.remoteCwd) : [];
  });

  const pick = (path: string) => {
    setCwd(path);
    setFieldError(null);
  };
  const pickRemote = (p: RemotePlace) => {
    setPlace(p);
    setFieldError(null);
  };
  const chooseTarget = (t: TargetInfo) => {
    if (place().target === t.name) return;
    setPlace({ target: t.name, remoteCwd: "" });
    setFieldError(null);
    setPicking(false);
  };

  const ready = () => (where() === "local" ? !!cwd().trim() : !!place().target && !!place().remoteCwd);

  const submit = async (e?: Event) => {
    e?.preventDefault();
    if (pending() || connecting() || !ready()) return;
    setPending(true);
    setFieldError(null);
    setFailed(false);
    try {
      const p = place();
      props.onCreated(await createSession(where() === "local" ? cwd().trim() : { target: p.target!, remoteCwd: p.remoteCwd }));
    } catch (err) {
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
        setFieldError(err.message || "That folder doesn't exist. Pick one that does.");
        setPicking(false);
        field?.focus();
      } else {
        setFailed(true);
      }
      setPending(false);
    }
  };

  /** Starts the connection agent and hands the user straight into it, like a created session. */
  const connect = async () => {
    if (connecting() || pending()) return;
    setConnecting(true);
    setConnectError(null);
    try {
      props.onCreated(await connectTarget());
    } catch (err) {
      setConnectError((err as Error).message || "Unknown error.");
      setConnecting(false);
    }
  };

  const switchTo = (w: Where) => {
    if (w === where()) return;
    setWhere(w);
    setPicking(false);
    setFieldError(null);
  };
  const onTabKey = (e: KeyboardEvent, i: number) => {
    const last = TABS.length - 1;
    const next =
      e.key === "ArrowRight" ? (i === last ? 0 : i + 1) : e.key === "ArrowLeft" ? (i === 0 ? last : i - 1) : e.key === "Home" ? 0 : e.key === "End" ? last : -1;
    if (next < 0) return;
    e.preventDefault();
    switchTo(TABS[next]!.id);
    tabEls[next]?.focus();
  };

  const cancel = () => !pending() && !connecting() && props.onCancel();

  /** Enter/Space picks a row of a listbox; double-click picks it and submits. */
  const rowKeys = (e: KeyboardEvent, act: () => void) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      act();
    }
  };

  return (
    <>
      <div class="scrim" onClick={cancel} />
      <div
        class="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ns-title"
        ref={(el) => trapFocus(el)}
        onKeyDown={(e) => {
          if (e.key === "Escape") cancel();
        }}
      >
        <div class="modal-head">
          <h2 class="modal-title" id="ns-title">
            New Session
          </h2>
        </div>
        <form class="modal-body" id="ns-form" ref={form} onSubmit={submit}>
          <Show when={failed()}>
            <Banner tone="error" title="Couldn't create the session." body="Nothing was written. Try again." />
          </Show>
          {/* flex: none — .tabs scrolls sideways, so in the scrolling modal body it would otherwise shrink to nothing. */}
          <div class="tabs" role="tablist" aria-label="Where pi runs" style={{ flex: "none" }}>
            <For each={TABS}>
              {(t, i) => (
                <button
                  type="button"
                  role="tab"
                  class={where() === t.id ? "tab tab-active" : "tab"}
                  id={`ns-tab-${t.id}`}
                  aria-selected={where() === t.id ? "true" : "false"}
                  aria-controls="ns-tabpanel"
                  tabindex={where() === t.id ? 0 : -1}
                  ref={(el) => (tabEls[i()] = el)}
                  onClick={() => switchTo(t.id)}
                  onKeyDown={(e) => onTabKey(e, i())}
                >
                  <Icon name={t.id === "local" ? "folder" : "terminal"} small />
                  {t.label}
                </button>
              )}
            </For>
          </div>
          <div class="stack" role="tabpanel" id="ns-tabpanel" aria-labelledby={`ns-tab-${where()}`}>
            <Show when={where() === "local"}>
              <div class="field">
                <label class="field-label" for="ns-cwd">
                  Folder
                </label>
                <button
                  ref={field}
                  type="button"
                  class="input input-mono folder-field"
                  id="ns-cwd"
                  title={cwd() || undefined}
                  aria-expanded={picking() ? "true" : "false"}
                  aria-controls="ns-picker"
                  aria-invalid={fieldError() ? "true" : undefined}
                  aria-describedby="ns-cwd-hint ns-cwd-error"
                  onClick={() => setPicking((v) => !v)}
                >
                  <span class="folder-field-value truncate" classList={{ "folder-field-empty": !cwd() }}>
                    {cwd() ? tildePath(cwd(), home()) : "Choose a folder"}
                  </span>
                  <Icon name="chevron-down" small class="icon-twist" />
                </button>
                <span class="field-hint" id="ns-cwd-hint">
                  pi runs in this folder and can read and change files in it.
                </span>
                <span class="field-error" id="ns-cwd-error">
                  {fieldError()}
                </span>
              </div>
              <Show when={picking()}>
                <FolderPicker start={cwd()} recents={recent()} onPick={pick} onClose={() => setPicking(false)} />
              </Show>
              <Show when={!picking() && recent().length > 0}>
                <div class="field">
                  <span class="field-label" id="ns-recent">
                    Recent folders
                  </span>
                  <ul class="list folder-list" role="listbox" aria-labelledby="ns-recent">
                    <For each={recent()}>
                      {(c) => (
                        <li
                          class="list-row list-row-interactive"
                          role="option"
                          tabindex="0"
                          title={c}
                          aria-selected={c === cwd().trim() ? "true" : "false"}
                          onClick={() => pick(c)}
                          onDblClick={() => {
                            pick(c);
                            form.requestSubmit();
                          }}
                          onKeyDown={(e) => rowKeys(e, () => pick(c))}
                        >
                          <Icon name="folder" small />
                          <span class="list-title truncate">{tildePath(c, home())}</span>
                        </li>
                      )}
                    </For>
                  </ul>
                </div>
              </Show>
            </Show>

            <Show when={where() === "remote"}>
              <Show when={connectError()}>
                {(msg) => <Banner tone="error" title="Couldn't start the connection agent." body={msg()} />}
              </Show>
              <div class="field">
                <span class="field-label" id="ns-targets">
                  Target
                </span>
                <Show
                  when={!targets.loading || targets.latest}
                  fallback={
                    <span class="field-hint" aria-live="polite">
                      Loading targets…
                    </span>
                  }
                >
                  <Show
                    when={!targets.error}
                    fallback={
                      <span class="field-error" role="alert">
                        Couldn't read the targets. {(targets.error as Error)?.message}
                      </span>
                    }
                  >
                    <Show
                      when={targetList().length > 0}
                      fallback={
                        <span class="field-hint">
                          No targets yet. They live in <code>~/.pi/agent/targets.json</code>, and the connection agent can write one for
                          you.
                        </span>
                      }
                    >
                      <ul class="list folder-list" role="listbox" aria-labelledby="ns-targets">
                        <For each={targetList()}>
                          {(t) => (
                            <li
                              class="list-row list-row-interactive"
                              role="option"
                              tabindex="0"
                              title={[t.host ?? t.name, t.kind, t.error].filter(Boolean).join(" · ")}
                              aria-selected={place().target === t.name ? "true" : "false"}
                              onClick={() => chooseTarget(t)}
                              onKeyDown={(e) => rowKeys(e, () => chooseTarget(t))}
                            >
                              <Icon name="terminal" small />
                              <span class="list-title truncate">{targetName(t)}</span>
                              <span class="folder-picker-link truncate">{t.host ?? t.kind}</span>
                              <TargetStatus target={t} checking={checking()} />
                            </li>
                          )}
                        </For>
                      </ul>
                    </Show>
                  </Show>
                </Show>
              </div>

              <Show when={place().target}>
                {(name) => (
                  <>
                    <div class="field">
                      <label class="field-label" for="ns-rcwd">
                        Folder on {nameOf(name())}
                      </label>
                      <button
                        ref={field}
                        type="button"
                        class="input input-mono folder-field"
                        id="ns-rcwd"
                        title={place().remoteCwd ? remoteLabel({ target: name(), remoteCwd: place().remoteCwd }) : undefined}
                        aria-expanded={picking() ? "true" : "false"}
                        aria-controls="ns-picker"
                        aria-invalid={fieldError() ? "true" : undefined}
                        aria-describedby="ns-rcwd-hint ns-cwd-error"
                        onClick={() => setPicking((v) => !v)}
                      >
                        <span class="folder-field-value truncate" classList={{ "folder-field-empty": !place().remoteCwd }}>
                          {place().remoteCwd || `Choose a folder on ${nameOf(name())}`}
                        </span>
                        <Icon name="chevron-down" small class="icon-twist" />
                      </button>
                      <span class="field-hint" id="ns-rcwd-hint">
                        <Show
                          when={current() && targetDown(current()!)}
                          fallback={<>pi's tools run in this folder on {current()?.host ?? nameOf(name())}. Its transcript stays here.</>}
                        >
                          The last check couldn't reach {nameOf(name())}
                          {current()?.error ? `: ${current()!.error!.replace(/[.\s]+$/, "")}.` : "."} Browsing tries again.
                        </Show>
                      </span>
                      <span class="field-error" id="ns-cwd-error">
                        {fieldError()}
                      </span>
                    </div>
                    <Show when={picking()}>
                      <Show when={name()} keyed>
                        {(n) => (
                          <FolderPicker
                            start={place().remoteCwd}
                            recents={recentOnTarget()}
                            remote={{ target: n, name: nameOf(n) }}
                            onPick={(path) => pickRemote({ target: n, remoteCwd: path })}
                            onClose={() => setPicking(false)}
                          />
                        )}
                      </Show>
                    </Show>
                  </>
                )}
              </Show>

              <Show when={!picking() && recentRemote().length > 0}>
                <div class="field">
                  <span class="field-label" id="ns-rrecent">
                    Recent remote folders
                  </span>
                  <ul class="list folder-list" role="listbox" aria-labelledby="ns-rrecent">
                    <For each={recentRemote()}>
                      {(p) => (
                        <li
                          class="list-row list-row-interactive"
                          role="option"
                          tabindex="0"
                          title={remoteLabel(p)}
                          aria-selected={p.target === place().target && p.remoteCwd === place().remoteCwd ? "true" : "false"}
                          onClick={() => pickRemote(p)}
                          onDblClick={() => {
                            pickRemote(p);
                            form.requestSubmit();
                          }}
                          onKeyDown={(e) => rowKeys(e, () => pickRemote(p))}
                        >
                          <Icon name="terminal" small />
                          <span class="list-title truncate">{p.remoteCwd}</span>
                          <span class="folder-picker-link truncate">{nameOf(p.target)}</span>
                        </li>
                      )}
                    </For>
                  </ul>
                </div>
              </Show>

              <div class="field">
                <span class="field-hint" id="ns-connect-hint">
                  A new host? An agent asks for its address, checks it answers, and adds it to your targets.
                </span>
                <div>
                  <button
                    type="button"
                    class="button"
                    aria-describedby="ns-connect-hint"
                    aria-disabled={connecting() || pending() ? "true" : undefined}
                    onClick={connect}
                  >
                    <Icon name="plus" />
                    {connecting() ? "Starting…" : "Connect a New Target…"}
                  </button>
                </div>
              </div>
            </Show>
          </div>
        </form>
        <div class="modal-foot">
          <button type="submit" form="ns-form" class="button button-primary" aria-disabled={pending() || connecting() || !ready() ? "true" : undefined}>
            {pending() ? "Creating…" : "Create Session"}
          </button>
          <span class="modal-spacer" />
          <button type="button" class="button button-ghost" onClick={cancel}>
            Cancel
          </button>
        </div>
      </div>
    </>
  );
}
