import { createSignal, For, Match, Show, Switch } from "solid-js";
import type { UsageBalance, UsageInsight, UsageProvider, UsageWindow } from "../../shared/protocol";
import { refreshUsage } from "../lib/api";
import { clockTime, duration, relativeTime, shortDate, thousands } from "../lib/format";
import { meterTone, money, pct, PROVIDER_NAME, providerChip, providerProblem, windowLabel } from "../lib/insights";
import type { Poll } from "../lib/poll";
import { InsightsPage, iso, Skeletons } from "./InsightsPage";
import { Banner, Chip, CountChip, Icon } from "./ui";

function Meter(props: { w: UsageWindow; now: number }) {
  const tone = () => meterTone(props.w);
  const resetAt = () => (props.w.resetsAt ? Date.parse(props.w.resetsAt) : NaN);
  /** The window already reset: the reading describes a window that's gone. */
  const past = () => resetAt() <= props.now;
  const reset = () => {
    const at = resetAt();
    if (Number.isNaN(at)) return null;
    if (past()) return { lead: "Reset at ", time: clockTime(props.w.resetsAt!), rest: ". New reading at the next refresh." };
    const left = at - props.now;
    return { lead: left < 86_400_000 ? `Resets in ${duration(left)}` : `Resets ${shortDate(at, props.now)}` };
  };
  /** MCP quota counts, when the source reports them: "12 of 1,000 uses". */
  const uses = () => {
    const { used, limit } = props.w;
    return props.w.label === "mcp" && used !== undefined && limit !== undefined ? `${thousands(used)} of ${thousands(limit)} uses` : null;
  };
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
      <div class="meter-track" aria-hidden="true">
        <span
          class="meter-fill"
          classList={{ "meter-fill-warn": tone() === "warn", "meter-fill-error": tone() === "error" }}
          style={{ "--meter-pct": `${Math.min(100, Math.max(0, props.w.pct))}%` }}
        />
      </div>
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
      <Show when={uses()}>{(u) => <p class="meter-context">{u()}</p>}</Show>
    </div>
  );
}

/**
 * A prepaid credit provider (DeepSeek) reports money left, not windows: the meter's number
 * without the bar, and no reset — there's nothing to reset.
 */
function Balance(props: { b: UsageBalance }) {
  const breakdown = () => {
    const parts: string[] = [];
    if (props.b.granted > 0) parts.push(`Granted ${money(props.b.granted, props.b.currency)}`);
    if (props.b.toppedUp > 0) parts.push(`Topped up ${money(props.b.toppedUp, props.b.currency)}`);
    return parts.length ? parts.join(" \u00b7 ") : null;
  };
  return (
    <>
      <div class="meter">
        <p class="meter-head">
          <span class="meter-label">Balance</span>
          <span class="meter-value">{money(props.b.total, props.b.currency)}</span>
        </p>
        <Show when={breakdown()}>{(b) => <p class="meter-context">{b()}</p>}</Show>
      </div>
      <Show when={!props.b.available}>
        <p class="usage-note">This balance can't fund calls. They'll fail until it's topped up.</p>
      </Show>
    </>
  );
}

function UsageCard(props: { p: UsageProvider; now: number }) {
  const problem = () => providerProblem(props.p);
  return (
    <article class="card usage-card" aria-labelledby={`u-${props.p.id}`}>
      <header class="card-head">
        <h3 class="card-title" id={`u-${props.p.id}`}>
          {PROVIDER_NAME[props.p.id]}
        </h3>
        <Show when={providerChip(props.p)}>{(c) => <Chip tone={c().tone}>{c().text}</Chip>}</Show>
      </header>
      <div class="card-body">
        <Show
          when={problem()}
          fallback={
            <Show when={props.p.balance} fallback={<For each={props.p.windows}>{(w) => <Meter w={w} now={props.now} />}</For>}>
              {(b) => <Balance b={b()} />}
            </Show>
          }
        >
          {(pr) => (
            <p class="usage-note">
              {pr().lead}
              <Show when={pr().code}>
                <code>{pr().code}</code>
              </Show>
              {pr().rest}
            </p>
          )}
        </Show>
      </div>
    </article>
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
        <div class="insights-grid">
          {/* One block per provider the page can show (claude, openai, ollama, zai, deepseek). */}
          <Skeletons count={5} />
        </div>
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
            <div class="insights-grid">
              <For each={data().providers}>{(p) => <UsageCard p={p} now={props.now} />}</For>
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
          {(f) => <span title={iso(f())}>Updated {relativeTime(iso(f()), props.now)}</span>}
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
