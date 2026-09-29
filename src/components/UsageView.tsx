import { createSignal, For, type JSX, Match, Show, Switch } from "solid-js";
import type { UsageBalance, UsageClaudeLogin, UsageInsight, UsageProvider, UsageWindow } from "../../shared/protocol";
import { refreshUsage } from "../lib/api";
import { duration, relativeIn, relativeTime } from "../lib/format";
import {
  authCaption,
  balanceBreakdown,
  claudeLoginGroups,
  claudeLoginName,
  claudeLoginNote,
  claudeLoginStanding,
  claudeLoginSubtitle,
  claudeLoginTitle,
  extraUsageMeter,
  meterReset,
  meterTone,
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
} from "../lib/insights";
import type { Poll } from "../lib/poll";
import { InsightsPage, iso, ListSkeleton } from "./InsightsPage";
import { Banner, Chip, CountChip, Icon } from "./ui";

/** The bar under a meter's number: aria-hidden (the number is the value), never animated. */
function Track(props: { pct: number }) {
  const tone = () => meterTone({ label: "", pct: props.pct });
  return (
    <div class="meter-track" aria-hidden="true">
      <span
        class="meter-fill"
        classList={{ "meter-fill-warn": tone() === "warn", "meter-fill-error": tone() === "error" }}
        style={{ "--meter-pct": `${Math.min(100, Math.max(0, props.pct))}%` }}
      />
    </div>
  );
}

function Meter(props: { w: UsageWindow; now: number }) {
  const reset = () => meterReset(props.w, props.now);
  /** The window already reset: the reading describes a window that's gone. */
  const past = () => Boolean(reset()?.time);
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
      <Track pct={props.w.pct} />
      <Show when={reset()}>
        {(r) => (
          <p class="meter-context" title={props.w.resetsAt}>
            {r().lead}
            <Show when={r().time}>
              <span class="text-mono">{r().time}</span>
              {r().rest}
            </Show>
          </p>
        )}
      </Show>
      <Show when={usesLine(props.w)}>{(u) => <p class="meter-context">{u()}</p>}</Show>
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
function UsageCard(props: {
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
}) {
  const problem = (): UsageLine | null => (props.note ? { rest: props.note } : providerProblem(props.p, props.now));
  const signIn = () => authCaption(props.p, props.now);
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
        <Show when={providerChip(props.p)}>{(c) => <Chip tone={c().tone}>{c().text}</Chip>}</Show>
      </header>
      <div class="card-body">
        {props.lead}
        <Show
          when={problem()}
          fallback={
            <>
              <Show when={props.p.balance} fallback={<For each={props.p.windows}>{(w) => <Meter w={w} now={props.now} />}</For>}>
                {(b) => <Balance b={b()} />}
              </Show>
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

/** One Claude login: its email as the title, its standing on this device, then its usage like any card. */
function ClaudeLoginCard(props: { l: UsageClaudeLogin; now: number; shares: UsageClaudeLogin[] }) {
  const standing = () => claudeLoginStanding(props.l, props.now);
  return (
    <UsageCard
      p={props.l.usage}
      now={props.now}
      title={claudeLoginTitle(props.l)}
      plan={claudeLoginSubtitle(props.l, props.now, props.shares.length > 0)}
      headId={`u-claude-${props.l.id}`}
      note={claudeLoginNote(props.l)}
      lead={
        <p class="usage-login-standing">
          <Chip tone={standing().tone} title={standing().title}>
            {standing().text}
          </Chip>
          <Show when={props.l.inUse}>
            <span class="chip chip-count" title="The first ready login in this device's order: new chats start on it">
              In use for new chats
            </span>
          </Show>
        </p>
      }
      foot={
        <Show when={props.shares.length}>
          <p class="usage-card-caption text-caption text-muted">
            Same account as {props.shares.map((o) => claudeLoginName(o, props.now)).join(", ")}: they share these limits.
          </p>
        </Show>
      }
    />
  );
}

/** Claude's cards: one per login on this device, logins of one account together under its head. */
function ClaudeLoginCards(props: { logins: UsageClaudeLogin[]; now: number }) {
  return (
    <For each={claudeLoginGroups(props.logins)}>
      {(group) => (
        <>
          <Show when={group.length > 1}>
            <h3 class="usage-account-head text-caption text-muted">
              {claudeLoginTitle(group[0]!)} · {group.length} logins, one account
            </h3>
          </Show>
          <For each={group}>{(l) => <ClaudeLoginCard l={l} now={props.now} shares={group.filter((o) => o.id !== l.id)} />}</For>
        </>
      )}
    </For>
  );
}

/** The page body, directly in `.insights-inner`: the h1 already names it, so no section head. */
function UsageBody(props: {
  usage: Poll<UsageInsight>;
  now: number;
  /** Why the last Refresh Usage failed, until one succeeds. */
  refreshError: string | null;
  refreshing: boolean;
  onRefresh(): void;
}) {
  const u = () => props.usage.data();
  const age = () => props.now - (u()?.fetchedAt ?? props.now);
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
            <Show when={usageSummary(data(), props.now)}>{(lead) => <p class="usage-lead">{lead()}</p>}</Show>
            <div class="insights-grid">
              <For each={data().providers}>
                {(p) => (
                  <Show when={p.id === "claude" && data().claudeLogins?.length ? data().claudeLogins : null} fallback={<UsageCard p={p} now={props.now} />}>
                    {(logins) => <ClaudeLoginCards logins={logins()} now={props.now} />}
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
export function UsageView(props: { usage: Poll<UsageInsight>; now: number; titleRef(el: HTMLHeadingElement): void }) {
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
      <UsageBody usage={props.usage} now={props.now} refreshError={refreshError()} refreshing={refreshing()} onRefresh={() => void refresh()} />
    </InsightsPage>
  );
}
