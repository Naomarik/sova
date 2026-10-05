import { createResource, createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import type { ClaudeAccountsInfo, ClaudeLoginFlowState, ClaudeLoginIdentity, ClaudeLoginRow, ClaudeLoginStanding, ClaudePoolInfo, ClaudePoolLogin } from "../../shared/protocol";
import {
  cancelClaudeLogin,
  clearClaudeLogin,
  getClaudeAccounts,
  patchClaudeLogin,
  pinClaudePoolLogin,
  putClaudeLoginOrder,
  putClaudePoolOrder,
  removeClaudeLogin,
  returnClaudePoolLogin,
  sendClaudeLoginCode,
  setClaudePoolKeeper,
  startClaudeLogin,
} from "../lib/api";
import { type AccountGroup, accountGroups, addedText, type LoginFacts, loginName, moveAccount, moveLogin, sharedQuotaText } from "../lib/claude-login-groups";
import { holderChip, movingText, poolActions, usageText } from "../lib/claude-pool";
import { stampTime } from "../lib/format";
import { Banner, Chip, Icon } from "./ui";
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

function Standing(props: { login: { id: string; standing: ClaudeLoginStanding; enabled: boolean; signedIn?: boolean } }) {
  const s = () => props.login.standing;
  return (
    <Show
      when={props.login.signedIn !== false || props.login.id === "default"}
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

/** What the account blocks read of a login, from either wire shape. */
const loginFacts = (l: { id: string; label?: string; addedAt?: number; identity: ClaudeLoginIdentity | null }): LoginFacts => ({
  id: l.id,
  ...(l.label ? { label: l.label } : {}),
  ...(l.addedAt !== undefined ? { addedAt: l.addedAt } : {}),
  ...(l.identity?.accountUuid ? { account: l.identity.accountUuid } : {}),
});

/**
 * One account (§app.claude-logins/device-order): its email, organization, plan and how many logins
 * share its quota, Up / Down for the whole account, then its logins as compact rows (`children`).
 */
function AccountBlock(props: {
  identity: ClaudeLoginIdentity | null;
  count: number;
  index: number;
  total: number;
  busy: boolean;
  /** The account's latest usage, when the pool has one. */
  usage?: string;
  onMove: (by: -1 | 1) => void;
  children: JSX.Element;
}) {
  const title = () => props.identity?.email ?? "Unknown account";
  const facts = () => [props.identity?.orgName, props.identity?.planLabel, sharedQuotaText(props.count)].filter(Boolean).join(" · ");
  return (
    <li class="accounts-account">
      <div class="accounts-account-head">
        <div class="accounts-login-text">
          <span class="accounts-account-name">{title()}</span>
          <Show when={facts()}>
            <span class="accounts-login-fact">{facts()}</span>
          </Show>
          <Show when={props.usage}>{(u) => <span class="accounts-login-fact text-num">{u()}</span>}</Show>
        </div>
        <Show when={props.total > 1}>
          <span class="accounts-login-actions">
            <button type="button" class="button button-sm button-ghost" aria-label={`Move ${title()} up`} disabled={props.busy || props.index === 0} onClick={() => props.onMove(-1)}>
              Up
            </button>
            <button
              type="button"
              class="button button-sm button-ghost"
              aria-label={`Move ${title()} down`}
              disabled={props.busy || props.index === props.total - 1}
              onClick={() => props.onMove(1)}
            >
              Down
            </button>
          </span>
        </Show>
      </div>
      <ol class="accounts-account-logins">{props.children}</ol>
    </li>
  );
}

/**
 * A login inside its account: its name (renamed in place: its `label`), when it was added, its
 * chips, and its controls — `before` (the pool's pin, Return, Sign In Again), Up / Down inside the
 * account, Use, Clear, Remove.
 */
function LoginRow(props: {
  id: string;
  name: string;
  /** Its account's email: controls are named "Login 1 of a@example.com", unique across accounts. */
  account?: string;
  label?: string;
  addedAt?: number;
  busy: boolean;
  chips: JSX.Element;
  facts?: JSX.Element;
  before?: JSX.Element;
  index: number;
  count: number;
  onMove: (by: -1 | 1) => void;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  clearable: boolean;
  onClear: () => void;
  onRename: (label: string | null) => void;
  /** What Remove's confirmation says goes away and what stays. */
  removeText: string;
  onRemove: () => void;
}) {
  const [naming, setNaming] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  const [confirm, setConfirm] = createSignal(false);
  let renameButton: HTMLButtonElement | undefined;
  const startRename = () => {
    setDraft(props.label ?? "");
    setNaming(true);
  };
  const stopRename = () => {
    setNaming(false);
    queueMicrotask(() => renameButton?.focus());
  };
  const save = () => {
    const next = draft().trim();
    if (next !== (props.label ?? "")) props.onRename(next || null);
    stopRename();
  };
  const added = () => addedText(props.addedAt);
  const called = () => (props.account ? `${props.name} of ${props.account}` : props.name);
  return (
    <li class="accounts-login" data-login={props.id}>
      <div class="accounts-login-text">
        <Show
          when={naming()}
          fallback={
            <span class="accounts-login-title">
              <span class="accounts-login-name">{props.name}</span>
              <Show when={added()}>{(a) => <span class="accounts-login-fact">{a()}</span>}</Show>
            </span>
          }
        >
          <form
            class="accounts-rename"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <input
              class="input"
              maxlength={80}
              value={draft()}
              placeholder={props.name}
              aria-label={`Name of ${called()}`}
              ref={(el) => queueMicrotask(() => el.select())}
              onInput={(e) => setDraft(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  stopRename();
                }
              }}
            />
            <span class="button-row">
              <button type="submit" class="button button-primary button-sm" disabled={props.busy}>
                Save Name
              </button>
              <button type="button" class="button button-ghost button-sm" onClick={stopRename}>
                Cancel
              </button>
            </span>
          </form>
        </Show>
        {props.facts}
      </div>
      <span class="accounts-login-chips">{props.chips}</span>
      <div class="accounts-login-actions">
        <Show when={!naming()}>
          <button type="button" class="button button-sm button-ghost" aria-label={`Rename ${called()}`} disabled={props.busy} ref={renameButton} onClick={startRename}>
            <Icon name="pencil" small />
            Rename
          </button>
        </Show>
        {props.before}
        <Show when={props.count > 1}>
          <button type="button" class="button button-sm button-ghost" aria-label={`Move ${called()} up`} disabled={props.busy || props.index === 0} onClick={() => props.onMove(-1)}>
            Up
          </button>
          <button
            type="button"
            class="button button-sm button-ghost"
            aria-label={`Move ${called()} down`}
            disabled={props.busy || props.index === props.count - 1}
            onClick={() => props.onMove(1)}
          >
            Down
          </button>
        </Show>
        <label class="toggle toggle-switch accounts-login-toggle">
          <span>Use</span>
          <input type="checkbox" checked={props.enabled} disabled={props.busy} aria-label={`Use ${called()}`} onChange={(e) => props.onToggle(e.currentTarget.checked)} />
          <span class="toggle-box" />
        </label>
        <Show when={props.clearable}>
          <button type="button" class="button button-sm" disabled={props.busy} onClick={() => props.onClear()}>
            Clear
          </button>
        </Show>
        <button type="button" class="button button-sm button-destructive" aria-label={`Remove ${called()}`} disabled={props.busy} onClick={() => setConfirm(true)}>
          Remove
        </button>
      </div>
      <Show when={confirm()}>
        <div class="accounts-login-confirm" role="group" aria-label={`Remove ${called()}`}>
          <p class="field-hint">{props.removeText}</p>
          <span class="button-row">
            <button type="button" class="button button-sm button-ghost" onClick={() => setConfirm(false)}>
              Cancel
            </button>
            <button
              type="button"
              class="button button-sm button-destructive"
              disabled={props.busy}
              onClick={() => {
                setConfirm(false);
                props.onRemove();
              }}
            >
              Remove Login
            </button>
          </span>
        </div>
      </Show>
    </li>
  );
}

/** The login actions both lists share: they save at once and answer the whole tab. */
interface LoginActions {
  busy: boolean;
  onToggle: (id: string, enabled: boolean) => void;
  onClear: (id: string) => void;
  onRemove: (id: string) => void;
  onRename: (id: string, label: string | null) => void;
}

/** "5h 42% · weekly 18%" of the account's latest published reading (its logins share one quota). */
function accountUsage(logins: readonly ClaudePoolLogin[]): string | undefined {
  const latest = logins.filter((l) => usageText(l)).sort((a, b) => b.usage!.at - a.usage!.at)[0];
  return latest ? usageText(latest) : undefined;
}

/**
 * The pool (§app.claude-logins/pool, mesh on): every login of every device, one block per
 * account, each login with where it is (this device, another, Free, Stuck), its pin, and the
 * keeper choice.
 */
function PoolLogins(props: LoginActions & {
  pool: ClaudePoolInfo;
  act: (what: string, fn: () => Promise<unknown>) => void;
  onSignIn: (id: string) => void;
}) {
  const deviceLabel = (id: string) => props.pool.devices.find((d) => d.id === id)?.label ?? id;
  const groups = (): AccountGroup<ClaudePoolLogin>[] => accountGroups(props.pool.logins, loginFacts);
  const order = (ids: string[] | null) => {
    if (ids) props.act("order", () => putClaudePoolOrder(ids));
  };
  return (
    <>
      <div class="accounts-keeper">
        <label class="field accounts-keeper-field">
          <span class="field-label">Keeper</span>
          <span class="select-wrap">
            <select
              class="select"
              aria-describedby="accounts-keeper-hint"
              disabled={props.busy}
              onChange={(e) => props.act("keeper", () => setClaudePoolKeeper(e.currentTarget.value))}
            >
              <Show when={!props.pool.keeper.id}>
                <option value="" selected>
                  Choose a device
                </option>
              </Show>
              <For each={props.pool.devices}>
                {(d) => (
                  <option value={d.id} selected={d.id === props.pool.keeper.id}>
                    {d.label}
                    {d.self ? " (this device)" : d.up ? "" : " (offline)"}
                  </option>
                )}
              </For>
            </select>
          </span>
        </label>
        <p class="field-hint" id="accounts-keeper-hint">
          <Show
            when={props.pool.keeper.id && !props.pool.keeper.up}
            fallback="Keeps every free login and never runs Claude on them. A device borrows from it when it needs Claude."
          >
            {props.pool.keeper.label} is offline: no device can borrow until it's back. Devices holding a login keep working.
          </Show>
        </p>
      </div>
      <Show when={props.pool.apiKeysOnly}>
        <Banner tone="info" title="This device syncs API keys only, so it never borrows or keeps a Claude login." body="Its Claude processes use Claude Code's own login here." />
      </Show>
      <Show
        when={props.pool.logins.length > 0}
        fallback={<p class="field-hint">No logins in the pool yet. Add one below: it starts on this device; away from the keeper it goes back when it's idle.</p>}
      >
        <ol class="accounts-accounts" data-testid="claude-pool">
          <For each={groups()}>
            {(group, gi) => (
              <AccountBlock
                identity={group.logins[0]!.identity}
                count={group.logins.length}
                index={gi()}
                total={groups().length}
                busy={props.busy}
                usage={accountUsage(group.logins)}
                onMove={(by) => order(moveAccount(groups(), gi(), by, loginFacts))}
              >
                <For each={group.logins}>
                  {(l, li) => {
                    const chip = () => holderChip(l, props.pool.self);
                    const acts = () => poolActions(l);
                    const name = () => loginName(loginFacts(l), group.logins.map(loginFacts));
                    return (
                      <LoginRow
                        id={l.id}
                        name={name()}
                        {...(l.identity?.email ? { account: l.identity.email } : {})}
                        {...(l.label ? { label: l.label } : {})}
                        addedAt={l.addedAt}
                        busy={props.busy}
                        chips={
                          <>
                            <Chip tone={chip().tone} title={chip().title}>
                              {chip().text}
                            </Chip>
                            <Standing login={l} />
                          </>
                        }
                        facts={<Show when={movingText(l)}>{(m) => <span class="accounts-login-fact">{m()}</span>}</Show>}
                        before={
                          <>
                            <Show when={acts().pinnable}>
                              <label class="accounts-pin">
                                <span class="select-wrap">
                                  <select
                                    class="select"
                                    aria-label={`Always give ${name()}${l.identity?.email ? ` of ${l.identity.email}` : ""} to`}
                                    disabled={props.busy}
                                    onChange={(e) => props.act(`pin-${l.id}`, () => pinClaudePoolLogin(l.id, e.currentTarget.value || null))}
                                  >
                                    <option value="" selected={!l.pin}>
                                      No pin
                                    </option>
                                    <For each={props.pool.devices}>
                                      {(d) => (
                                        <option value={d.id} selected={d.id === l.pin}>
                                          Pin to {d.label}
                                        </option>
                                      )}
                                    </For>
                                  </select>
                                </span>
                              </label>
                            </Show>
                            <Show when={acts().returnable}>
                              <button
                                type="button"
                                class="button button-sm"
                                disabled={props.busy}
                                title={`${deviceLabel(l.holder.device)} returns it to the keeper after its current turn.`}
                                onClick={() => props.act(`return-${l.id}`, () => returnClaudePoolLogin(l.id))}
                              >
                                Return
                              </button>
                            </Show>
                            <Show when={acts().signIn}>
                              <button type="button" class="button button-sm" disabled={props.busy} onClick={() => props.onSignIn(l.id)}>
                                Sign In Again
                              </button>
                            </Show>
                          </>
                        }
                        index={li()}
                        count={group.logins.length}
                        onMove={(by) => order(moveLogin(groups(), gi(), li(), by, loginFacts))}
                        enabled={l.enabled}
                        onToggle={(enabled) => props.onToggle(l.id, enabled)}
                        clearable={l.standing.state !== "ready"}
                        onClear={() => props.onClear(l.id)}
                        onRename={(label) => props.onRename(l.id, label)}
                        removeText={`${name()} leaves the pool on every device: the device that has it stops its Claude processes on it and deletes its copy. Transcripts stay.`}
                        onRemove={() => props.onRemove(l.id)}
                      />
                    );
                  }}
                </For>
              </AccountBlock>
            )}
          </For>
        </ol>
      </Show>
    </>
  );
}

/** The mesh-off list (§app.claude-logins/device-order): this device's added logins, one block per account, in its order. */
function LocalLogins(props: LoginActions & { logins: ClaudeLoginRow[]; onOrder: (ids: string[]) => void }) {
  const groups = (): AccountGroup<ClaudeLoginRow>[] => accountGroups(props.logins, loginFacts);
  const order = (ids: string[] | null) => {
    if (ids) props.onOrder(ids);
  };
  return (
    <Show when={props.logins.length > 0}>
      <ol class="accounts-accounts" data-testid="claude-logins">
        <For each={groups()}>
          {(group, gi) => (
            <AccountBlock
              identity={group.logins[0]!.identity}
              count={group.logins.length}
              index={gi()}
              total={groups().length}
              busy={props.busy}
              onMove={(by) => order(moveAccount(groups(), gi(), by, loginFacts))}
            >
              <For each={group.logins}>
                {(l, li) => {
                  const name = () => loginName(loginFacts(l), group.logins.map(loginFacts));
                  return (
                    <LoginRow
                      id={l.id}
                      name={name()}
                      {...(l.identity?.email ? { account: l.identity.email } : {})}
                      {...(l.label ? { label: l.label } : {})}
                      {...(l.addedAt !== undefined ? { addedAt: l.addedAt } : {})}
                      busy={props.busy}
                      chips={<Standing login={l} />}
                      index={li()}
                      count={group.logins.length}
                      onMove={(by) => order(moveLogin(groups(), gi(), li(), by, loginFacts))}
                      enabled={l.enabled}
                      onToggle={(enabled) => props.onToggle(l.id, enabled)}
                      clearable={l.standing.state !== "ready"}
                      onClear={() => props.onClear(l.id)}
                      onRename={(label) => props.onRename(l.id, label)}
                      removeText={`Sova signs ${name()} out of Claude Code and deletes its directory. Its sessions' transcripts stay; work on it moves to the next login.`}
                      onRemove={() => props.onRemove(l.id)}
                    />
                  );
                }}
              </For>
            </AccountBlock>
          )}
        </For>
      </ol>
    </Show>
  );
}

/**
 * Settings → Accounts (§app.claude-logins): this device's Claude logins by account, in the order
 * every Claude process tries them, and adding one through Claude Code's own sign-in. Every change
 * saves at once. With the mesh on, the pool's blocks (PoolLogins) come first; either way this
 * device's own Claude Code login, its last resort, comes after them.
 */
export function AccountsSettingsSection() {
  const [info, { mutate, refetch }] = createResource(getClaudeAccounts);
  const loaded = () => (info.error ? undefined : info());
  const [busy, setBusy] = createSignal<string | null>(null);
  const [actionError, setActionError] = createSignal<string | null>(null);

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

  /** A pool action: it answers the pool, so the whole tab is read again. */
  const act = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what);
    setActionError(null);
    try {
      await fn();
    } catch (err) {
      setActionError(sentence(err instanceof Error ? err.message : String(err)));
    } finally {
      setBusy(null);
      void refetch();
    }
  };

  /** Claude Code's own login here. */
  const own = () => loaded()?.logins.find((l) => l.id === "default");
  /** The mesh-off list: every added login here, in its order (with the pool, the pool's blocks list them). */
  const added = () => (loaded()?.pool ? [] : (loaded()?.logins ?? []).filter((l) => l.id !== "default"));
  /** The block `default` shares its account with, by email: they share one quota. */
  const ownShares = () => {
    const uuid = own()?.identity?.accountUuid;
    if (!uuid) return null;
    const others = loaded()?.pool?.logins ?? added();
    return others.some((l) => l.identity?.accountUuid === uuid) ? own()!.identity?.email ?? null : null;
  };
  const actions: Omit<LoginActions, "busy"> = {
    onToggle: (id, enabled) => void run(`enable-${id}`, () => patchClaudeLogin(id, { enabled })),
    onClear: (id) => void run(`clear-${id}`, () => clearClaudeLogin(id)),
    onRemove: (id) => void run(`remove-${id}`, () => removeClaudeLogin(id)),
    onRename: (id, label) => void run(`label-${id}`, () => patchClaudeLogin(id, { label })),
  };


  // -- the add-login flow --
  const [flow, setFlow] = createSignal<ClaudeLoginFlowState | null>(null);
  const [code, setCode] = createSignal("");
  const [copied, setCopied] = createSignal(false);
  /** Signing an existing login in again (its id), rather than adding one. */
  const [flowTarget, setFlowTarget] = createSignal<string | null>(null);
  const flowOpen = () => {
    const f = flow();
    return !!f && f.state !== "done" && f.state !== "failed";
  };
  const startFlow = async (target?: string) => {
    setActionError(null);
    setCode("");
    setFlowTarget(target ?? null);
    setFlow({ state: "starting" });
    try {
      setFlow(await startClaudeLogin(target));
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
      <Show
        when={loaded()?.pool}
        fallback={
          <p class="settings-intro">
            Every Claude process on <Show when={loaded()} fallback="this device">{(i) => <strong>{i().device.label}</strong>}</Show> runs on the first
            ready login in this order. When one hits a usage limit or its sign-in fails, the work moves to the next.
          </p>
        }
      >
        <p class="settings-intro">
          Every device on the mesh shares these logins, one device at a time. A device that needs Claude borrows a free one from the keeper, and
          gives it back after a usage limit, when you ask, or, on a device other than the keeper, after 30 minutes idle unless a chat there picked it. Claude Code's own login on each device is its last resort.
        </p>
      </Show>

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
            <Show when={i().pool}>
              {(pool) => (
                <PoolLogins
                  pool={pool()}
                  busy={!!busy()}
                  act={(what, fn) => void act(what, fn)}
                  onSignIn={(id) => void startFlow(id)}
                  onToggle={actions.onToggle}
                  onClear={actions.onClear}
                  onRemove={actions.onRemove}
                  onRename={actions.onRename}
                />
              )}
            </Show>
            <LocalLogins
              logins={added()}
              busy={!!busy()}
              onOrder={(ids) => void run("order", () => putClaudeLoginOrder([...ids, "default"]))}
              onToggle={actions.onToggle}
              onClear={actions.onClear}
              onRemove={actions.onRemove}
              onRename={actions.onRename}
            />
            <Show when={own()}>
              {(l) => (
                <>
                  <h4 class="accounts-own-title">This device's own login</h4>
                  <ol class="accounts-logins">
                    <li class="accounts-login" data-login="default">
                      <div class="accounts-login-text">
                        <span class="accounts-login-name">{nameOf(l())}</span>
                        <span class="accounts-login-fact">{factsOf(l())}</span>
                        <Show when={ownShares()}>{(email) => <span class="accounts-login-fact">Same account as {email()} above: they share one quota.</span>}</Show>
                      </div>
                      <Standing login={l()} />
                      <div class="accounts-login-actions">
                        <label class="toggle toggle-switch accounts-login-toggle">
                          <span>Use</span>
                          <input
                            type="checkbox"
                            checked={l().enabled}
                            disabled={!!busy()}
                            aria-label={`Use ${nameOf(l())}`}
                            onChange={(e) => actions.onToggle("default", e.currentTarget.checked)}
                          />
                          <span class="toggle-box" />
                        </label>
                        <Show when={l().standing.state !== "ready"}>
                          <button type="button" class="button button-sm" disabled={!!busy()} onClick={() => actions.onClear("default")}>
                            Clear
                          </button>
                        </Show>
                      </div>
                    </li>
                  </ol>
                  {/* macOS: Claude Code's own login is in a keychain this server can't read (§app.claude-logins/macos-keychain). */}
                  <Show when={i().claudeOwnLoginUnreadable}>
                    <p class="field-hint">On macOS, add your Claude login under Settings → Accounts.</p>
                  </Show>
                </>
              )}
            </Show>
            <Show when={!i().pool && i().elsewhere.length > 0}>
              <p class="field-hint">
                {i().elsewhere.length} other {i().elsewhere.length === 1 ? "login belongs" : "logins belong"} to another device and{" "}
                {i().elsewhere.length === 1 ? "isn't" : "aren't"} used here.
              </p>
            </Show>
            <Show when={actionError()}>{(e) => <p class="field-error">{e()}</p>}</Show>

            <fieldset class="settings-delegate-profile accounts-add">
              <legend class="settings-delegate-legend">{flowTarget() && flow() ? "Sign a login in again" : "Add a login"}</legend>
              <Show
                when={flow()}
                fallback={
                  <>
                    <p class="field-hint">
                      <Show when={i().pool} fallback="Sign in to another Claude subscription. Claude Code keeps its sign-in in its own directory on this device.">
                        Sign in to another Claude subscription. It starts on this device and joins the pool.
                      </Show>
                    </p>
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
                              <Chip tone="success">{flowTarget() ? "Signed in again" : "Added"}</Chip>
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
                        <button type="button" class="button button-sm" onClick={() => void startFlow(flowTarget() ?? undefined)}>
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
