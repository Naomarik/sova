import { createSignal, For, type JSX, Match, Show, Switch } from "solid-js";
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
import { InsightsPage, iso, ListSkeleton } from "./InsightsPage";
import { Banner, Chip, CountChip, Icon } from "./ui";
import { BurnChart, BurnLines, BurnStrip, Track } from "./UsageHistory";
import { OllamaSections, ResetDay, type ResetDayControl } from "./UsageOllama";

function Meter(props: { w: UsageWindow; now: number; past?: string; resetDay?: ResetDayControl }) {
  const reset = () => meterReset(props.w, props.now, props.past);
  /** The window already reset: the reading describes a window that's gone. */
  const past = () => Boolean(reset()?.time);
  /** The pace tick, while the window has a known span and its reset is ahead. */
  const at = () => (past() ? null : (windowPace(props.w, props.now)?.elapsed ?? null));
  return (
    <div class="meter" classList={{ "meter-ghost": past() }}>
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
      {/* How fast it is going, and, a day or more long, its history (§app.insights/usage-burn). */}
      <BurnLines lines={burnLines(props.w, props.now)} />
      <Show when={(props.w.history || props.w.burn) && chartSpan(props.w, props.now)}>{(span) => <BurnChart w={props.w} span={span()} now={props.now} />}</Show>
      {/* Under a day (the 5-hour window): no chart, a strip of its past windows instead. */}
      <Show when={props.w.history && shortSpan(props.w)}>
        <BurnStrip w={props.w} now={props.now} />
      </Show>
    </div>
  );
}

/**
 * Claude's pay-as-you-go spend past the plan: a quota fill against the extra-usage cap, or, when
 * the source only says it's switched on, the head alone reading "On" (no bar, like a balance).
 */
function ExtraMeter(props: { x: { pct: number } | { on: true } }) {
  const fill = () => ("pct" in props.x ? props.x.pct : null);
  return (
    <div class="meter">
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
  );
}

/**
 * A prepaid credit provider (DeepSeek) reports money left, not windows: the meter's number
 * without the bar, and no reset — there's nothing to reset.
 */
function Balance(props: { b: UsageBalance }) {
  return (
    <>
      <div class="meter">
        <p class="meter-head">
          <span class="meter-label">Balance</span>
          <span class="meter-value">{money(props.b.total, props.b.currency)}</span>
        </p>
        <Show when={balanceBreakdown(props.b)}>{(b) => <p class="meter-context">{b()}</p>}</Show>
        <Show when={balanceBurnLine(props.b)}>{(l) => <BurnLines lines={[l()]} />}</Show>
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
 * One provider's card: name, plan subtitle and chip in the head; its meters (or balance) and
 * notes in the body, or the one note that replaces them when the provider isn't ok.
 */
export function UsageCard(props: {
  p: UsageProvider;
  now: number;
  /** A Claude login's card: its own title, caption and id instead of the provider's. */
  title?: string;
  plan?: string;
  headId?: string;
  /** Before the meters: a login's standing. */
  lead?: JSX.Element;
  /** Replaces the provider's own note when the card has no meters for a reason of its own. */
  note?: string | null;
  /** After the sign-in caption. */
  foot?: JSX.Element;
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
    <article class="card usage-card" aria-labelledby={headId()}>
      <header class="card-head">
        <div class="usage-card-heading">
          <h3 class="card-title" classList={{ "usage-login-title": !!props.title }} id={headId()}>
            {props.title ?? PROVIDER_NAME[props.p.id]}
          </h3>
          <Show when={props.plan ?? planLabel(props.p)}>{(plan) => <p class="usage-card-plan text-caption text-muted">{plan()}</p>}</Show>
        </div>
        <Show when={providerChip(props.p, props.now)}>{(c) => <Chip tone={c().tone}>{c().text}</Chip>}</Show>
      </header>
      <div class="card-body">
        {props.lead}
        <Show
          when={problem()}
          fallback={
            <>
              <Show when={props.p.balance} fallback={<For each={props.p.windows}>{(w) => <Meter w={w} now={props.now} past={props.past} resetDay={w.label === "month" ? props.resetDay : undefined} />}</For>}>
                {(b) => <Balance b={b()} />}
              </Show>
              <Show when={props.p.id === "ollama" && (props.p.activity || props.p.credits)}><OllamaSections p={props.p} now={props.now} resetDay={props.resetDay} /></Show>
              <Show when={extraUsageMeter(props.p)}>{(x) => <ExtraMeter x={x()} />}</Show>
              <Show when={props.p.limitReached}>
                <p class="usage-note">Usage limit reached. Calls may fail until it resets.</p>
              </Show>
              <Show when={props.p.lastKnown}>
                <p class="usage-card-caption text-caption text-muted" title={props.p.error}>
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
        <Show when={signIn()}>
          {(c) => (
            <p class="usage-card-caption text-caption text-muted">
              <UsageText line={c()} />
            </p>
          )}
        </Show>
        {props.foot}
      </div>
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
 * for an account of one login outside the pool, that login's chips above the meters.
 */
function ClaudeAccountCard(props: { account: UsageClaudeLogin[]; now: number }) {
  const reading = () => accountReading(props.account, props.now);
  const first = () => props.account[0]!;
  const caption = () => claudeAccountLoginsCaption(props.account);
  const listed = () => caption() !== null;
  return (
    <UsageCard
      p={reading().usage}
      now={props.now}
      title={claudeLoginTitle(first())}
      plan={claudeAccountSubtitle(props.account)}
      headId={`u-claude-${first().id}`}
      note={claudeLoginNote(reading().login)}
      past={claudePastNote(reading().login)}
      noSignIn={props.account.length > 1}
      lead={
        <Show when={!listed()}>
          <p class="usage-login-standing">
            <LoginChips l={first()} now={props.now} reading={reading().usage} />
          </p>
        </Show>
      }
      foot={
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

/** Claude's cards: one per account, in the order its first login has on this device. */
function ClaudeAccountCards(props: { logins: UsageClaudeLogin[]; now: number }) {
  return <For each={claudeAccounts(props.logins)}>{(account) => <ClaudeAccountCard account={account} now={props.now} />}</For>;
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
        {/* A head and a row per provider the page can show (claude, openai, ollama, zai, deepseek). */}
        <ListSkeleton groups={5} rows={1} />
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
            <div class="insights-grid">
              <For each={data().providers}>
                {(p) => (
                  <Show when={p.id === "claude" && data().claudeLogins?.length ? data().claudeLogins : null} fallback={<UsageCard p={p} now={props.now} resetDay={p.id === "ollama" ? resetDay(data()) : undefined} />}>
                    {(logins) => <ClaudeAccountCards logins={logins()} now={props.now} />}
                  </Show>
                )}
              </For>
            </div>
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
