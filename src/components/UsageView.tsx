import { createSignal, For, type JSX, Match, onCleanup, Show, Switch } from "solid-js";
import type { UsageBalance, UsageClaudeLogin, UsageInsight, UsageProvider, UsageWindow } from "../../shared/protocol";
import { putUsageResetDay, refreshUsage } from "../lib/api";
import { balanceBurnLine, burnLines, chartSpan, shortSpan } from "../lib/usage-burn";
import { duration, relativeIn, relativeTime } from "../lib/format";
import {
  accountReading,
  authCaption,
  balanceBreakdown,
  claudeAccountLoginsCaption,
  claudeAccounts,
  claudeAccountSubtitle,
  claudeLoginHolder,
  claudeLoginName,
  claudeLoginNote,
  claudePastNote,
  claudeLoginStanding,
  claudeLoginTitle,
  extraUsageMeter,
  meterReset,
  money,
  pct,
  planLabel,
  PROVIDER_NAME,
  providerChip,
  providerProblem,
  usageSummary,
  type UsageLine,
  usesLine,
  windowLabel,
  windowPace,
} from "../lib/insights";
import type { Poll } from "../lib/poll";
import { InsightsPage, iso } from "./InsightsPage";
import { Banner, Chip, CountChip, Icon } from "./ui";
import { BurnChart, BurnLines, BurnStrip, Track } from "./UsageHistory";
import { OllamaLines, ResetDay, type ResetDayControl } from "./UsageOllama";

/**
 * One window's summary (number, bar, reset, uses and burn), paired with its history.
 * The rate stays with the reading rather than leaving an empty column beside a tall chart.
 */
function WindowLine(props: { w: UsageWindow; now: number; past?: string; resetDay?: ResetDayControl }) {
  const reset = () => meterReset(props.w, props.now, props.past);
  /** The window already reset: the reading describes a window that's gone. */
  const past = () => Boolean(reset()?.time);
  /** The pace tick, while the window has a known span and its reset is ahead. */
  const at = () => (past() ? null : (windowPace(props.w, props.now)?.elapsed ?? null));
  const burn = () => burnLines(props.w, props.now);
  const strip = () => Boolean(props.w.history && shortSpan(props.w));
  return (
    <div class="usage-line">
      <div class="meter usage-line-meter" classList={{ "meter-ghost": past() }}>
        <p class="meter-head">
          <span class="meter-label">
            {windowLabel(props.w)}
            <Show when={props.w.active}>
              {" "}
              <CountChip title="The window your current model counts against">Active</CountChip>
            </Show>
          </span>
          <span class="meter-value">
            {pct(props.w)}%<span class="meter-of"> used</span>
          </span>
        </p>
        <Track pct={props.w.pct} at={at()} />
        <Show
          when={reset()}
          fallback={
            <Show when={props.resetDay}>
              {(c) => (
                <div class="meter-context">
                  Reset day unknown · <ResetDay c={c()} />
                </div>
              )}
            </Show>
          }
        >
          {(r) => (
            <div class="meter-context" title={props.w.resetsAt}>
              {r().lead}
              <Show when={r().time}>
                <span class="text-mono">{r().time}</span>
                {r().rest}
              </Show>
              <Show when={props.resetDay}>
                {(c) => (
                  <>
                    {" · "}
                    <ResetDay c={c()} />
                  </>
                )}
              </Show>
            </div>
          )}
        </Show>
        <Show when={usesLine(props.w)}>{(u) => <p class="meter-context">{u()}</p>}</Show>
        <Show when={!strip() && burn().length > 0}>
          <div class="usage-window-burn"><BurnLines lines={burn()} /></div>
        </Show>
      </div>
      <Show when={props.w.history || props.w.burn}>
        <div class="usage-line-trend">
          <Show when={strip()}><BurnLines lines={burn()} /></Show>
          <Show when={(props.w.history || props.w.burn) && chartSpan(props.w, props.now)}>{(span) => <BurnChart w={props.w} span={span()} now={props.now} />}</Show>
          {/* Under a day (the 5-hour window): no chart, a strip of its past windows instead. */}
          <Show when={props.w.history && shortSpan(props.w)}>
            <BurnStrip w={props.w} now={props.now} />
          </Show>
        </div>
      </Show>
    </div>
  );
}

/**
 * Claude's pay-as-you-go spend past the plan: a quota fill against the extra-usage cap, or, when
 * the source only says it's switched on, the head alone reading "On" (no bar, like a balance).
 * A line of its own, with no trend block.
 */
function ExtraLine(props: { x: { pct: number } | { on: true } }) {
  const fill = () => ("pct" in props.x ? props.x.pct : null);
  return (
    <div class="usage-line">
      <div class="meter usage-line-meter">
        <p class="meter-head">
          <span class="meter-label">Extra usage</span>
          <Show when={fill() !== null} fallback={<span class="meter-value">On</span>}>
            <span class="meter-value">
              {Math.round(fill()!)}%<span class="meter-of"> used</span>
            </span>
          </Show>
        </p>
        <Show when={fill() !== null}>
          <Track pct={fill()!} />
          <p class="meter-context">Of your extra-usage spend cap</p>
        </Show>
      </div>
    </div>
  );
}

/**
 * A prepaid credit provider (DeepSeek) reports money left, not windows: the meter's number
 * without the bar, and no reset — there's nothing to reset. Its spend line is the trend block.
 */
function BalanceLine(props: { b: UsageBalance }) {
  return (
    <>
      <div class="usage-line">
        <div class="meter usage-line-meter">
          <p class="meter-head">
            <span class="meter-label">Balance</span>
            <span class="meter-value">{money(props.b.total, props.b.currency)}</span>
          </p>
          <Show when={balanceBreakdown(props.b)}>{(b) => <p class="meter-context">{b()}</p>}</Show>
        </div>
        <Show when={balanceBurnLine(props.b)}>
          {(l) => (
            <div class="usage-line-trend">
              <BurnLines lines={[l()]} />
            </div>
          )}
        </Show>
      </div>
      <Show when={!props.b.available}>
        <p class="usage-note">This balance can't fund calls. They'll fail until it's topped up.</p>
      </Show>
    </>
  );
}

/** A note or caption's words, its command (if any) in `<code>`. */
function UsageText(props: { line: UsageLine }) {
  return (
    <>
      {props.line.lead}
      <Show when={props.line.code}>
        <code>{props.line.code}</code>
      </Show>
      {props.line.rest}
    </>
  );
}

/**
 * One provider's row (§app.insights/usage-cards): its identity (name, plan caption, chip), then
 * its lines — one per window, or its balance, Ollama's sections and notes — or the one note that
 * replaces them when the provider isn't ok; a Claude account's logins and the sign-in caption
 * last. CSS puts the identity, logins and sign-in in a left column on a wide page.
 */
export function UsageRow(props: {
  p: UsageProvider;
  now: number;
  /** A Claude account's row: its own title, caption and id instead of the provider's. */
  title?: string;
  plan?: string;
  headId?: string;
  /** Under the caption: a single login's standing. */
  standing?: JSX.Element;
  /** Replaces the provider's own note when the row has no meters for a reason of its own. */
  note?: string | null;
  /** After the lines, before the sign-in caption: a Claude account's logins. */
  logins?: JSX.Element;
  /** No sign-in caption: the reading is one of several logins', each with its own sign-in. */
  noSignIn?: boolean;
  /** A ghost meter's sentence in place of "New reading at the next refresh." (a free login's figures). */
  past?: string;
  /** Ollama's declared reset day, on its monthly meter. */
  resetDay?: ResetDayControl;
}) {
  const problem = (): UsageLine | null => (props.note ? { rest: props.note } : providerProblem(props.p, props.now));
  const signIn = () => (props.noSignIn ? null : authCaption(props.p, props.now));
  const headId = () => props.headId ?? `u-${props.p.id}`;
  return (
    <article class="usage-row" aria-labelledby={headId()}>
      <header class="usage-row-id">
        <div class="usage-row-heading">
          <Show when={props.title} fallback={<h2 class="usage-row-title" id={headId()}>{PROVIDER_NAME[props.p.id]}</h2>}>
            <h3 class="usage-row-title" id={headId()}>{props.title}</h3>
          </Show>
          <Show when={props.plan ?? planLabel(props.p)}>{(plan) => <p class="usage-row-plan text-caption text-muted">{plan()}</p>}</Show>
        </div>
        <Show when={providerChip(props.p, props.now)}>{(c) => <Chip tone={c().tone}>{c().text}</Chip>}</Show>
        {props.standing}
      </header>
      <div class="usage-row-lines">
        <Show
          when={problem()}
          fallback={
            <>
              <Show when={props.p.balance} fallback={<For each={props.p.windows}>{(w) => <WindowLine w={w} now={props.now} past={props.past} resetDay={w.label === "month" ? props.resetDay : undefined} />}</For>}>
                {(b) => <BalanceLine b={b()} />}
              </Show>
              <Show when={props.p.id === "ollama" && (props.p.activity || props.p.credits)}>
                <OllamaLines p={props.p} now={props.now} resetDay={props.resetDay} />
              </Show>
              <Show when={extraUsageMeter(props.p)}>{(x) => <ExtraLine x={x()} />}</Show>
              <Show when={props.p.limitReached}>
                <p class="usage-note">Usage limit reached. Calls may fail until it resets.</p>
              </Show>
              <Show when={props.p.lastKnown}>
                <p class="usage-caption text-caption text-muted" title={props.p.error}>
                  Last stored reading — an older pi session is rewriting the cache.
                </p>
              </Show>
            </>
          }
        >
          {(pr) => (
            <p class="usage-note">
              <UsageText line={pr()} />
            </p>
          )}
        </Show>
      </div>
      {props.logins}
      <Show when={signIn()}>
        {(c) => (
          <p class="usage-caption usage-row-auth text-caption text-muted">
            <UsageText line={c()} />
          </p>
        )}
      </Show>
    </article>
  );
}

/** A login's standing chip, and "In use for new chats" on the one a new chat starts on. */
function LoginChips(props: { l: UsageClaudeLogin; now: number; reading: UsageProvider }) {
  const standing = () => claudeLoginStanding(props.l, props.now, props.reading);
  return (
    <>
      <Chip tone={standing().tone} title={standing().title}>
        {standing().text}
      </Chip>
      <Show when={claudeLoginHolder(props.l)}>
        {(h) => (
          <Chip tone={h().tone} title="Where this login is">
            {h().text}
          </Chip>
        )}
      </Show>
      <Show when={props.l.inUse}>
        <span class="chip chip-count" title="The first ready login in this device's order: new chats start on it">
          In use for new chats
        </span>
      </Show>
    </>
  );
}

/**
 * One Claude account (§app.insights/usage-cards): its email as the title, its usage once (the
 * freshest reading of its logins, which share one quota), then its logins as compact rows — or,
 * for an account of one login outside the pool, that login's chips under the caption.
 */
function ClaudeAccountRow(props: { account: UsageClaudeLogin[]; now: number }) {
  const reading = () => accountReading(props.account, props.now);
  const first = () => props.account[0]!;
  const caption = () => claudeAccountLoginsCaption(props.account);
  const listed = () => caption() !== null;
  return (
    <UsageRow
      p={reading().usage}
      now={props.now}
      title={claudeLoginTitle(first())}
      plan={claudeAccountSubtitle(props.account)}
      headId={`u-claude-${first().id}`}
      note={claudeLoginNote(reading().login)}
      past={claudePastNote(reading().login)}
      noSignIn={props.account.length > 1}
      standing={
        <Show when={!listed()}>
          <p class="usage-login-standing">
            <LoginChips l={first()} now={props.now} reading={reading().usage} />
          </p>
        </Show>
      }
      logins={
        <Show when={listed()}>
          <div class="usage-logins">
            <p class="usage-logins-caption text-caption text-muted">{caption()}</p>
            <ul class="usage-logins-list">
              <For each={props.account}>
                {(l) => (
                  <li class="usage-logins-row" data-login={l.id}>
                    <span class="usage-logins-name">{claudeLoginName(l, props.account)}</span>
                    <span class="usage-login-standing">
                      <LoginChips l={l} now={props.now} reading={reading().usage} />
                    </span>
                  </li>
                )}
              </For>
            </ul>
          </div>
        </Show>
      }
    />
  );
}

/** Claude's rows: one per account, in the order its first login has on this device. */
export function ClaudeAccountRows(props: { logins: UsageClaudeLogin[]; now: number }) {
  return <For each={claudeAccounts(props.logins)}>{(account) => <ClaudeAccountRow account={account} now={props.now} />}</For>;
}

/**
 * First-load placeholder in the rows' shape, shown only once the page has been loading for
 * 300ms: one card per provider the page can show, each a title beside 2 meter lines.
 */
function UsageSkeleton() {
  const [show, setShow] = createSignal(false);
  const t = setTimeout(() => setShow(true), 300);
  onCleanup(() => clearTimeout(t));
  return (
    <Show when={show()}>
      <div class="usage-groups usage-skeleton" aria-hidden="true">
        <For each={Array.from({ length: 5 })}>
          {() => (
            <div class="card usage-rows"><div class="usage-row">
              <div class="usage-row-id">
                <span class="skeleton skeleton-line usage-skeleton-title" />
              </div>
              <div class="usage-row-lines">
                <For each={Array.from({ length: 2 })}>
                  {() => (
                    <div class="usage-line">
                      <div class="usage-line-meter">
                        <span class="skeleton skeleton-line usage-skeleton-label" />
                        <span class="skeleton skeleton-line usage-skeleton-track" />
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </div></div>
          )}
        </For>
      </div>
    </Show>
  );
}

/** Separate provider surfaces, keeping every account of Claude together in payload order. */
export function UsageGroups(props: { data: UsageInsight; now: number; resetDay?: ResetDayControl }) {
  return (
    <div class="usage-groups">
      <For each={props.data.providers}>
        {(p) => {
          const logins = () => p.id === "claude" && props.data.claudeLogins?.length ? props.data.claudeLogins : null;
          return (
            <section class="card usage-rows" aria-labelledby={logins() ? "u-claude-group" : `u-${p.id}`}>
              <Show when={logins()} fallback={<UsageRow p={p} now={props.now} resetDay={p.id === "ollama" ? props.resetDay : undefined} />}>
                {(accounts) => <>
                  <h2 class="usage-group-title" id="u-claude-group">{PROVIDER_NAME.claude}</h2>
                  <ClaudeAccountRows logins={accounts()} now={props.now} />
                </>}
              </Show>
            </section>
          );
        }}
      </For>
    </div>
  );
}

/** The page body, directly in `.insights-inner`: the h1 already names it, so no section head. */
function UsageBody(props: {
  usage: Poll<UsageInsight>;
  now: number;
  /** The open chat's recorded Claude login, for the summary lead (as the sidebar foot). */
  claudeLogin?: string | null;
  /** Why the last Refresh Usage failed, until one succeeds. */
  refreshError: string | null;
  refreshing: boolean;
  onRefresh(): void;
}) {
  const u = () => props.usage.data();
  const age = () => props.now - (u()?.fetchedAt ?? props.now);
  /** Ollama's reset-day control, from a server that sends the day (an older one offers none). */
  const resetDay = (d: UsageInsight): ResetDayControl | undefined =>
    d.ollamaResetDay === undefined
      ? undefined
      : { day: d.ollamaResetDay, save: async (day) => props.usage.set(await putUsageResetDay(day)) };
  const retry = () => (
    <button type="button" class="button button-sm" aria-disabled={props.refreshing ? "true" : undefined} onClick={() => !props.refreshing && props.onRefresh()}>
      Retry
    </button>
  );
  return (
    <Switch>
      <Match when={!u() && props.usage.pending()}>
        <UsageSkeleton />
      </Match>
      <Match when={u()?.available === false && u()?.reason === "corrupt"}>
        <Banner
          tone="error"
          title="Couldn't read usage."
          body={
            <>
              <code>usage-status.json</code> isn't valid JSON right now. Nothing was changed. It's rewritten at the next refresh.
            </>
          }
          action={retry()}
        />
      </Match>
      <Match when={u()?.available === false}>
        <div class="card">
          <div class="empty">
            <Icon name="gauge" class="empty-mark" />
            <p class="empty-title">No usage data yet.</p>
            <p class="empty-body">Nothing has fetched provider usage on this machine. Refresh Usage fetches it now.</p>
            <button type="button" class="button empty-action" aria-disabled={props.refreshing ? "true" : undefined} onClick={() => !props.refreshing && props.onRefresh()}>
              <Icon name="refresh" />
              Refresh Usage
            </button>
          </div>
        </div>
      </Match>
      <Match when={u()}>
        {(data) => (
          <>
            {/* Old data alone is no banner: Refresh Usage fetches it. It is one when that refresh failed. */}
            <Show when={data().stale && props.refreshError}>
              {(failure) => (
                <Banner tone="warn" icon="clock" title={`Usage is ${duration(age())} old.`} body={`Couldn't refresh: ${failure()}`} action={retry()} />
              )}
            </Show>
            <Show when={usageSummary(data(), props.now, props.claudeLogin)}>{(lead) => <p class="usage-lead">{lead()}</p>}</Show>
            {/* macOS: Claude Code's own login is in a keychain this server can't read (§app.claude-logins/macos-keychain). */}
            <Show when={data().claudeOwnLoginUnreadable}>
              <p class="usage-note">On macOS, add your Claude login under Settings → Accounts.</p>
            </Show>
            <UsageGroups data={data()} now={props.now} resetDay={resetDay(data())} />
          </>
        )}
      </Match>
    </Switch>
  );
}

/** `#/usage`: subscription usage limits, from the usage-status extension's cache file. */
export function UsageView(props: { usage: Poll<UsageInsight>; now: number; claudeLogin?: string | null; titleRef(el: HTMLHeadingElement): void }) {
  const fetchedAt = () => props.usage.data()?.fetchedAt ?? null;
  /** " · next refresh in 3m" while the cache's next fetch is ahead; a passed one says nothing. */
  const nextRefresh = () => {
    const next = props.usage.data()?.nextFetchAt;
    return next ? relativeIn(iso(next), props.now) : null;
  };
  const [refreshing, setRefreshing] = createSignal(false);
  const [refreshError, setRefreshError] = createSignal<string | null>(null);
  /** Refresh Usage: the server fetches every provider now; the result replaces the poll's value. */
  const refresh = async () => {
    if (refreshing()) return;
    setRefreshing(true);
    try {
      props.usage.set(await refreshUsage());
      setRefreshError(null);
    } catch (err) {
      setRefreshError((err as Error).message);
    } finally {
      setRefreshing(false);
    }
  };
  /** The stale banner carries a failed refresh over old data; the page banner carries the rest. */
  const staleFailure = () => Boolean(props.usage.data()?.stale && refreshError());
  return (
    <InsightsPage
      title="Usage"
      meta={
        <Show when={fetchedAt()} fallback={<span>Not read yet</span>}>
          {(f) => (
            <>
              <span title={iso(f())}>Updated {relativeTime(iso(f()), props.now)}</span>
              <Show when={nextRefresh()}>{(n) => <span title={iso(props.usage.data()!.nextFetchAt!)}> · next refresh {n()}</span>}</Show>
            </>
          )}
        </Show>
      }
      refreshLabel="Refresh Usage"
      onRefresh={() => void refresh()}
      refreshing={refreshing()}
      error={props.usage.error() ?? (staleFailure() ? null : refreshError())}
      errorTitle={props.usage.error() ? "Couldn't load usage." : "Couldn't refresh usage."}
      busy={!props.usage.data() && props.usage.pending()}
      titleRef={props.titleRef}
    >
      <UsageBody usage={props.usage} now={props.now} claudeLogin={props.claudeLogin} refreshError={refreshError()} refreshing={refreshing()} onRefresh={() => void refresh()} />
    </InsightsPage>
  );
}
