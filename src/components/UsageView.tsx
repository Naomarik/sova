import { For, Match, Show, Switch } from "solid-js";
import type { UsageBalance, UsageInsight, UsageProvider, UsageWindow } from "../../shared/protocol";
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
        {/* A kept reading: windows, or a credit provider's balance. */}
        <Show when={props.p.error && (props.p.windows.length > 0 || props.p.balance)}>
          <p class="usage-note">Last fetch failed: {props.p.error!.replace(/\.$/, "")}. Showing the previous reading.</p>
        </Show>
      </div>
    </article>
  );
}

/** The page body, directly in `.insights-inner`: the h1 already names it, so no section head. */
function UsageBody(props: { usage: Poll<UsageInsight>; now: number }) {
  const u = () => props.usage.data();
  const age = () => props.now - (u()?.fetchedAt ?? props.now);
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
          action={
            <button type="button" class="button button-sm" onClick={() => props.usage.refetch()}>
              Retry
            </button>
          }
        />
      </Match>
      <Match when={u()?.available === false}>
        <div class="card">
          <div class="empty">
            <Icon name="gauge" class="empty-mark" />
            <p class="empty-title">No usage data yet.</p>
            <p class="empty-body">
              The usage-status extension writes <code>~/.pi/agent/cache/usage-status.json</code> while pi runs, and we haven't found it.
            </p>
          </div>
        </div>
      </Match>
      <Match when={u()}>
        {(data) => (
          <>
            <Show when={data().stale}>
              <Banner
                tone="warn"
                icon="clock"
                title={`Usage is ${duration(age())} old.`}
                body={
                  <>
                    It refreshes while pi runs in a terminal. Open a pi session, or run <code>/usage-refresh</code> in one.
                  </>
                }
              />
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
  return (
    <InsightsPage
      title="Usage"
      meta={
        <Show when={fetchedAt()} fallback={<span>Not read yet</span>}>
          {(f) => <span title={iso(f())}>Updated {relativeTime(iso(f()), props.now)}</span>}
        </Show>
      }
      refreshLabel="Refresh Usage"
      onRefresh={() => props.usage.refetch()}
      error={props.usage.error()}
      errorTitle="Couldn't load usage."
      busy={!props.usage.data() && props.usage.pending()}
      titleRef={props.titleRef}
    >
      <UsageBody usage={props.usage} now={props.now} />
    </InsightsPage>
  );
}
