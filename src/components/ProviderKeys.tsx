import { createEffect, createResource, createSignal, For, type JSX, on, onCleanup, onMount, Show } from "solid-js";
import { getProviderKeys, removeProviderKey, revealProviderKey, saveProviderKey, testProviderKey } from "../lib/api";
import { loadModels } from "../lib/models";
import {
  ACCOUNT_TAB_LABELS,
  ACCOUNT_TAB_STORAGE,
  chipOf,
  createReveal,
  initialAccountTab,
  lastCheckedText,
  maskKey,
  type ProviderKeyRow,
  type ProviderKeysInfo,
  removeDetail,
  removeQuestion,
  sourceText,
  tabMark,
} from "../lib/provider-keys";
import { ACCOUNT_TABS, type AccountTab, accountTabRequest, openSettings } from "../lib/settings-nav";
import { AccountsSettingsSection } from "./AccountsSettings";
import { OpenAiAccountSection } from "./OpenAiAccount";
import { Banner, Chip } from "./ui";
import { RetryButton, sentence } from "./WorkerSlotRow";
import "./ProviderKeys.css";

const message = (err: unknown) => sentence(err instanceof Error ? err.message : String(err));
const READ_BACK = "Keys can only be read back on this computer.";

function storedTab(): string | null {
  try {
    return localStorage.getItem(ACCOUNT_TAB_STORAGE);
  } catch {
    return null;
  }
}

/**
 * Settings → Accounts (§app/provider-keys): a row of provider tabs, each with its status mark, over one tab's
 * panel. Claude keeps the Claude logins and the Claude Code line, OpenAI the ChatGPT sign-in, each with its
 * pay-as-you-go API key below; Ollama Cloud, DeepSeek and Z.ai are key tabs; Other provider picks any provider
 * that takes a key. It opens on the tab a link asked for, else the one last open in this browser.
 */
export function AccountsPanel(props: { claudeCli: () => JSX.Element }) {
  const [info, { mutate, refetch }] = createResource(getProviderKeys);
  const loaded = () => (info.error ? undefined : info());
  const [tab, setTab] = createSignal<AccountTab>(initialAccountTab(accountTabRequest(), storedTab()));
  createEffect(on(accountTabRequest, (asked) => asked && setTab(asked), { defer: true }));
  const choose = (t: AccountTab) => {
    setTab(t);
    try {
      localStorage.setItem(ACCOUNT_TAB_STORAGE, t);
    } catch {
      /* private mode: Claude next time */
    }
  };
  /** The tabs opened so far: a sign-in section mounts on its first opening and then stays. */
  const [seen, setSeen] = createSignal(new Set<AccountTab>());
  createEffect(() => {
    const t = tab();
    if (!seen().has(t)) setSeen(new Set([...seen(), t]));
  });
  const buttons = new Map<AccountTab, HTMLButtonElement>();
  const step = (delta: number) => {
    const i = ACCOUNT_TABS.indexOf(tab());
    const next = ACCOUNT_TABS[(i + delta + ACCOUNT_TABS.length) % ACCOUNT_TABS.length]!;
    choose(next);
    buttons.get(next)?.focus();
  };
  // The open tab scrolls into view on a phone's sideways row.
  createEffect(() => buttons.get(tab())?.scrollIntoView?.({ block: "nearest", inline: "nearest" }));
  /** One row came back changed: fold it into the list. */
  const onRow = (row: ProviderKeyRow) => {
    const now = loaded();
    if (!now) return void refetch();
    const rows = now.rows.some((r) => r.provider === row.provider) ? now.rows.map((r) => (r.provider === row.provider ? row : r)) : [...now.rows, row];
    mutate({ ...now, rows });
  };
  const rowOf = (provider: string) => loaded()?.rows.find((r) => r.provider === provider);

  return (
    <div class="accounts-panel" data-testid="accounts-panel">
      <div class="tabs accounts-tabs" role="tablist" aria-label="Providers">
        <For each={ACCOUNT_TABS}>
          {(t) => {
            const mark = () => tabMark(t, loaded());
            return (
              <button
                type="button"
                role="tab"
                class="tab"
                id={`accounts-tab-${t}`}
                aria-selected={tab() === t}
                aria-controls={`accounts-panel-${t}`}
                aria-label={mark().words ? `${ACCOUNT_TAB_LABELS[t]}: ${mark().words}` : ACCOUNT_TAB_LABELS[t]}
                tabindex={tab() === t ? 0 : -1}
                ref={(el) => buttons.set(t, el)}
                onClick={() => choose(t)}
                onKeyDown={(e) => {
                  if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
                  e.preventDefault();
                  step(e.key === "ArrowRight" ? 1 : -1);
                }}
              >
                <i class={`accounts-tab-dot${mark().tone ? ` accounts-tab-dot-${mark().tone}` : ""}`} aria-hidden="true" />
                {ACCOUNT_TAB_LABELS[t]}
              </button>
            );
          }}
        </For>
      </div>

      <Show when={info.error}>
        <Banner tone="error" title="Couldn't load this computer's API keys." body={message(info.error)} action={<RetryButton label="Try Again" onClick={() => void refetch()} />} />
      </Show>

      <div class="accounts-tab-panel" role="tabpanel" id={`accounts-panel-${tab()}`} aria-labelledby={`accounts-tab-${tab()}`}>
        {/* The sign-ins stay mounted once opened, only hidden on another tab: a sign-in waiting for its code
            survives a tab switch, and closing Settings still cancels it. Key rows unmount, so a shown key hides. */}
        <Show when={seen().has("claude")}>
          <div class="accounts-tab-panel" hidden={tab() !== "claude"}>
            <AccountsSettingsSection />
            {props.claudeCli()}
          </div>
        </Show>
        <Show when={tab() === "claude" && rowOf("anthropic")}>
          {(row) => <KeyRow row={row()} info={loaded()!} onRow={onRow} title="Anthropic API key" lead="Pay-as-you-go: billed per token by Anthropic, apart from any Claude subscription." />}
        </Show>
        <Show when={seen().has("openai")}>
          <div class="accounts-tab-panel" hidden={tab() !== "openai"}>
            <OpenAiAccountSection />
          </div>
        </Show>
        <Show when={tab() === "openai" && rowOf("openai")}>
          {(row) => <KeyRow row={row()} info={loaded()!} onRow={onRow} title="OpenAI API key" lead="Pay-as-you-go: billed per token by OpenAI, apart from your ChatGPT subscription." />}
        </Show>
        <For each={["ollama-cloud", "deepseek", "zai"] as const}>
          {(t) => (
            <Show when={tab() === t && rowOf(t)}>
              {(row) => <KeyRow row={row()} info={loaded()!} onRow={onRow} title={`${row().name} API key`} heading />}
            </Show>
          )}
        </For>
        <Show when={tab() === "other" && loaded()}>{(i) => <OtherProvider info={i()} onRow={onRow} />}</Show>
      </div>
    </div>
  );
}

/** The Other provider tab (§app.provider-keys/other): a picker of every provider that takes a key, then its row. */
function OtherProvider(props: { info: ProviderKeysInfo; onRow: (row: ProviderKeyRow) => void }) {
  const firstSaved = () => props.info.rows.find((r) => r.tab === "other" && r.saved)?.provider;
  const [picked, setPicked] = createSignal<string>(firstSaved() ?? "");
  const row = (): ProviderKeyRow | undefined => {
    const id = picked();
    if (!id) return undefined;
    const known = props.info.rows.find((r) => r.provider === id);
    if (known) return known;
    const p = props.info.others.find((o) => o.id === id);
    return p ? { provider: p.id, name: p.name, tab: "other", saved: false, source: "none", envSet: false, status: "nokey", checkable: false, providerEnabled: true } : undefined;
  };
  return (
    <section class="settings-delegate accounts-settings" aria-labelledby="settings-other-key-title">
      <div class="settings-type-head">
        <h3 class="settings-type-title" id="settings-other-key-title">
          Other provider
        </h3>
      </div>
      <p class="settings-intro">Save a key for any other provider your chats can use. Sova saves it as given and doesn't check it.</p>
      <label class="field">
        <span class="field-label">Provider</span>
        <span class="select-wrap">
          <select class="select" onChange={(e) => setPicked(e.currentTarget.value)}>
            <option value="" selected={!picked()}>
              Choose a provider
            </option>
            <For each={props.info.others}>
              {(o) => {
                const saved = () => props.info.rows.some((r) => r.provider === o.id && r.saved);
                return (
                  <option value={o.id} selected={picked() === o.id}>
                    {saved() ? `${o.name} · key saved` : o.name}
                  </option>
                );
              }}
            </For>
          </select>
        </span>
      </label>
      {/* Keyed by the provider, not the row: a refused paste keeps its field while the row is read again. */}
      <Show when={row() ? picked() : null} keyed>
        {(_id: string) => <KeyRow row={row()!} info={props.info} onRow={props.onRow} title={`${row()!.name} API key`} />}
      </Show>
    </section>
  );
}

/**
 * One provider's key (§app.provider-keys/key-tab, /pay-as-you-go, /other): its chip, the masked field with Save,
 * Replace and Remove, Show and Copy (on this computer only), the last check with Test, and the mesh and Models lines.
 */
function KeyRow(props: { row: ProviderKeyRow; info: ProviderKeysInfo; onRow: (row: ProviderKeyRow) => void; title: string; lead?: string; heading?: boolean }) {
  const r = () => props.row;
  const [paste, setPaste] = createSignal("");
  const [replacing, setReplacing] = createSignal(false);
  const [refused, setRefused] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal<"save" | "remove" | "test" | "show" | null>(null);
  const [confirm, setConfirm] = createSignal(false);
  const [shown, setShown] = createSignal<string | null>(null);
  const [copied, setCopied] = createSignal(false);
  const [now, setNow] = createSignal(Date.now());
  const reveal = createReveal(setShown);
  // Hidden on switching tabs and on closing Settings: both unmount the row.
  onCleanup(() => reveal.hide());
  const tick = setInterval(() => setNow(Date.now()), 30_000);
  onCleanup(() => clearInterval(tick));
  const editing = () => !r().saved || replacing();
  const idBase = `key-${r().provider}`;

  const act = async (what: "save" | "remove" | "test" | "show", fn: () => Promise<void>) => {
    setBusy(what);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
      setNow(Date.now());
    }
  };
  const save = () =>
    act("save", async () => {
      const res = await saveProviderKey(r().provider, paste());
      props.onRow(res.row);
      if (!res.saved) {
        // Never written: the paste stays so it can be corrected, and the saved key (if any) is unchanged.
        setRefused(res.refused ?? "The provider refused this key.");
        return;
      }
      reveal.hide();
      setRefused(null);
      setPaste("");
      setReplacing(false);
      void loadModels().catch(() => {});
    });
  const remove = () =>
    act("remove", async () => {
      const res = await removeProviderKey(r().provider);
      reveal.hide();
      setConfirm(false);
      props.onRow(res.row);
      void loadModels().catch(() => {});
    });
  const test = () => act("test", async () => props.onRow(await testProviderKey(r().provider)));
  const show = () => act("show", async () => reveal.show((await revealProviderKey(r().provider)).key));
  const copy = async () => {
    const key = shown();
    if (!key) return;
    try {
      await navigator.clipboard.writeText(key);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Couldn't copy the key. Select it in the field and copy it instead.");
    }
  };
  // A key in use that was never checked (saved before, or from the environment) is checked once on opening.
  onMount(() => {
    if (r().checkable && r().source !== "none" && !r().lastCheck && !r().command) void test();
  });

  const chip = () => chipOf(r(), !!refused());
  const canReveal = () => r().saved && !r().command;
  return (
    <section class={`accounts-key${props.heading ? " settings-delegate accounts-settings" : ""}`} aria-labelledby={`${idBase}-title`} data-testid={`key-row-${r().provider}`}>
      <div class="accounts-key-head">
        {props.heading ? (
          <h3 class="settings-type-title" id={`${idBase}-title`}>
            {props.title}
          </h3>
        ) : (
          <h4 class="accounts-key-title" id={`${idBase}-title`}>
            {props.title}
          </h4>
        )}
        <Chip tone={chip().tone}>{chip().text}</Chip>
      </div>
      <Show when={props.lead}>{(l) => <p class="field-hint">{l()}</p>}</Show>
      <Show when={r().envName}>
        <p class="field-hint">
          Key in use: {sourceText(r())}
          {r().source === "saved" && r().envSet ? `. The saved key wins over ${r().envName}.` : ""}
        </p>
      </Show>
      <Show when={r().otherSignIn}>
        <p class="field-hint">{r().name} holds a sign-in of another kind on this computer, so no key can be saved over it here.</p>
      </Show>

      <Show
        when={editing()}
        fallback={
          <div class="accounts-key-field">
            <input
              class="input input-mono"
              readOnly
              aria-label={`${r().name} key`}
              value={shown() ?? (r().command ? "A command saved on this computer" : maskKey(r().last4))}
              id={`${idBase}-value`}
            />
            <span class="button-row">
              <Show when={canReveal() && props.info.revealAllowed}>
                <Show
                  when={shown()}
                  fallback={
                    <button type="button" class="button button-sm" disabled={!!busy()} onClick={() => void show()}>
                      Show
                    </button>
                  }
                >
                  <button type="button" class="button button-sm" onClick={() => void copy()}>
                    {copied() ? "Copied" : "Copy"}
                  </button>
                  <button type="button" class="button button-sm button-ghost" onClick={() => reveal.hide()}>
                    Hide
                  </button>
                </Show>
              </Show>
              <button type="button" class="button button-sm" disabled={!!busy()} onClick={() => (reveal.hide(), setReplacing(true))}>
                Replace
              </button>
              <button type="button" class="button button-sm button-destructive" disabled={!!busy()} onClick={() => setConfirm(true)}>
                Remove
              </button>
            </span>
          </div>
        }
      >
        <div class="accounts-key-field">
          <input
            class="input input-mono"
            type="password"
            autocomplete="off"
            spellcheck={false}
            aria-label={`Paste the ${r().name} key`}
            placeholder="Paste the key"
            value={paste()}
            disabled={!!r().otherSignIn}
            onInput={(e) => {
              setPaste(e.currentTarget.value);
              setRefused(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && paste().trim()) void save();
            }}
          />
          <span class="button-row">
            <button type="button" class="button button-sm button-primary" disabled={!paste().trim() || !!busy() || !!r().otherSignIn} onClick={() => void save()}>
              {busy() === "save" ? (r().checkable ? "Checking…" : "Saving…") : "Save"}
            </button>
            <Show when={replacing()}>
              <button type="button" class="button button-sm button-ghost" onClick={() => (setReplacing(false), setPaste(""), setRefused(null))}>
                Cancel
              </button>
            </Show>
          </span>
        </div>
      </Show>
      <Show when={refused()}>{(why) => <p class="field-error">{sentence(why())} Nothing was saved; {r().saved ? "the saved key stays" : "no key is saved"}.</p>}</Show>
      <Show when={error()}>{(e) => <p class="field-error">{e()}</p>}</Show>
      <Show when={canReveal() && !props.info.revealAllowed && !editing()}>
        <p class="field-hint">{READ_BACK}</p>
      </Show>

      <Show when={confirm()}>
        <div class="accounts-login-confirm" role="group" aria-label={`Remove the ${r().name} key`}>
          <p class="field-hint">
            {removeQuestion(r(), props.info.meshSharesLogins)} {removeDetail(r())}
          </p>
          <span class="button-row">
            <button type="button" class="button button-sm button-ghost" onClick={() => setConfirm(false)}>
              Cancel
            </button>
            <button type="button" class="button button-sm button-destructive" disabled={!!busy()} onClick={() => void remove()}>
              Remove Key
            </button>
          </span>
        </div>
      </Show>

      <Show when={r().checkable && r().source !== "none"}>
        <div class="accounts-key-check">
          <p class="field-hint" aria-live="polite">
            {busy() === "test" ? "Checking…" : r().command ? "A command key isn't checked." : lastCheckedText(r().lastCheck, now())}
            <Show when={busy() !== "test" && r().lastCheck?.result !== "accepted" && r().lastCheck?.reason}>{(why) => ` · ${why()}`}</Show>
          </p>
          <button type="button" class="button button-sm" disabled={!!busy() || !!r().command} onClick={() => void test()}>
            Test
          </button>
        </div>
      </Show>
      <Show when={props.info.meshSharesLogins}>
        <p class="field-hint">
          Shared with the computers in your mesh that get logins.{" "}
          <button type="button" class="button-link" onClick={() => openSettings("mesh")}>
            Mesh settings
          </button>
        </p>
      </Show>
      <Show when={!r().providerEnabled}>
        <p class="field-hint">
          {r().name} is switched off in Settings → Models, so its models aren't offered.{" "}
          <button type="button" class="button-link" onClick={() => openSettings("models")}>
            Open Models
          </button>
        </p>
      </Show>
    </section>
  );
}
