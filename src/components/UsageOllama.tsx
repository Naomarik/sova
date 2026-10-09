import { createSignal, For, Show } from "solid-js";
import type { UsageProvider } from "../../shared/protocol";
import { activityMetrics, activityTrend, currentIncluded, endpointPrevious, includedCreditPct, reportedMoney } from "../lib/ollama-usage";

/** Ollama's declared reset day on its card: the day (null: none set) and how to save one. */
export interface ResetDayControl {
  day: number | null;
  save(day: number | null): Promise<void>;
}

/**
 * "Set" / "Change" and the inline day-of-month field it opens (§app.insights/usage-reset-day):
 * Enter or Save sends a day of 1–31, Escape or Cancel closes, Clear (once set) removes it.
 */
export function ResetDay(props: { c: ResetDayControl }) {
  const [open, setOpen] = createSignal(false);
  const [value, setValue] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  let input: HTMLInputElement | undefined;
  const start = () => {
    setValue(props.c.day !== null ? String(props.c.day) : "");
    setError(null);
    setOpen(true);
    queueMicrotask(() => input?.focus());
  };
  const send = async (day: number | null) => {
    setBusy(true);
    try {
      await props.c.save(day);
      setOpen(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const submit = () => {
    const v = value().trim();
    const day = Number(v);
    if (!/^\d{1,2}$/.test(v) || day < 1 || day > 31) return setError("Enter a day from 1 to 31.");
    void send(day);
  };
  return (
    <Show
      when={open()}
      fallback={
        <button type="button" class="usage-reset-day-link" onClick={start}>
          {props.c.day === null ? "Set" : "Change"}
        </button>
      }
    >
      <form
        class="usage-reset-day-field"
        // Our own message, not the browser's bubble: a day outside 1–31 says it in the card.
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy()) submit();
        }}
      >
        <label for="usage-reset-day-input">Reset day</label>
        <input
          ref={input}
          id="usage-reset-day-input"
          class="input"
          type="number"
          inputmode="numeric"
          min="1"
          max="31"
          value={value()}
          aria-invalid={error() ? "true" : undefined}
          aria-describedby={error() ? "usage-reset-day-error" : undefined}
          onInput={(e) => setValue(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setOpen(false);
            }
          }}
        />
        <button type="submit" class="button button-sm" aria-disabled={busy() ? "true" : undefined}>
          Save
        </button>
        <Show when={props.c.day !== null}>
          <button type="button" class="button button-sm button-ghost" aria-disabled={busy() ? "true" : undefined} onClick={() => !busy() && void send(null)}>
            Clear
          </button>
        </Show>
        <button type="button" class="button button-sm button-ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </form>
      <Show when={error()}>
        {(m) => (
          <p class="usage-reset-day-error" id="usage-reset-day-error" role="alert">
            {m()}
          </p>
        )}
      </Show>
    </Show>
  );
}

/** Ollama sources are separate from quota windows and the device's API-price ledger. */
export function OllamaSections(props: { p: UsageProvider; now: number; resetDay?: ResetDayControl }) {
  const activity = () => props.p.activity;
  const credits = () => props.p.credits;
  const period = () => credits()?.data?.included?.period;
  const previousCredits = () => endpointPrevious(credits(), props.now) || !!period() && (Date.parse(period()!.from) > props.now || Date.parse(period()!.until) <= props.now);
  const time = (t: number | undefined) => t === undefined ? "time unknown" : new Date(t).toISOString();
  const trend = () => activity()?.data ? activityTrend(activity()!.data!) : [];
  const scale = () => Math.max(0.01, ...trend().map((b) => b.usd ?? 0));
  return <>
    <Show
      when={credits()}
      fallback={
        <section class="stack stack-2" aria-labelledby="u-ollama-credits">
          <h4 id="u-ollama-credits" class="text-heading-s">Included credits</h4>
          <p class="meter-context">No balance reading yet.</p>
          <p class="meter-head"><span class="meter-label">Included remaining</span><span class="meter-value">Unknown</span></p>
          <p class="meter-head"><span class="meter-label">Included allowance</span><span class="meter-value">Unknown</span></p>
          <p class="meter-head"><span class="meter-label">Purchased remaining</span><span class="meter-value">Unknown</span></p>
        </section>
      }
    >{(r) => <section class="stack stack-2" aria-labelledby="u-ollama-credits">
      <h4 id="u-ollama-credits" class="text-heading-s">Included credits</h4>
      <p class="usage-card-caption text-caption text-muted">{previousCredits() ? "Previous reading · as of " : "As of "}{time(r().fetchedAt)}<Show when={r().error}> · {r().error}</Show></p>
      <div class="meter">
        <p class="meter-head"><span class="meter-label">Included remaining</span><span class="meter-value">{reportedMoney(r().data?.included?.balance_usd)}</span></p>
        <p class="meter-head"><span class="meter-label">Included allowance</span><span class="meter-value">{reportedMoney(r().data?.included?.allowance_usd)}</span></p>
        <Show when={includedCreditPct(r().data) !== undefined}>
          <p class="meter-context">{Math.round(includedCreditPct(r().data)!)}% included credits used</p>
          <Show when={currentIncluded(props.p, props.now)}>
            <div class="meter-track" aria-hidden="true"><span class="meter-fill" style={{ "--meter-pct": `${includedCreditPct(r().data)}%` }} /></div>
          </Show>
        </Show>
        <Show when={period()} fallback={<p class="meter-context">Included period: Unknown</p>}>{(p) => <p class="meter-context text-mono">{p().from} → {p().until} UTC · end exclusive</p>}</Show>
      </div>
      <p class="meter-head"><span class="meter-label">Purchased remaining</span><span class="meter-value">{reportedMoney(r().data?.purchased?.balance_usd)}</span></p>
      <For each={(["session", "weekly"] as const).filter((k) => r().data?.[k])}>{(k) => <p class="meter-context">{k === "session" ? "Session" : "Weekly"}: {r().data![k]!.remaining_percent}% remaining<Show when={r().data![k]!.resets_at}> · resets {r().data![k]!.resets_at}</Show></p>}</For>
    </section>}</Show>
    <Show when={activity()}>{(r) => <section class="stack stack-2" aria-labelledby="u-ollama-activity">
      <h4 id="u-ollama-activity" class="text-heading-s">Activity</h4>
      <p class="usage-card-caption text-caption text-muted">{endpointPrevious(r(), props.now) ? "Previous reading · as of " : "As of "}{time(r().fetchedAt)}<Show when={r().error}> · {r().error}</Show></p>
      <Show when={r().data}>{(a) => <>
        <p class="meter-context text-mono">{a().from} → {a().until} UTC · end exclusive · {a().scope}</p>
        <For each={activityMetrics(a())}>{(m) => <p class="meter-head"><span class="meter-label">{m.label}</span><span class="meter-value">{m.value}</span></p>}</For>
        <p class="meter-context">Request value, including plan and purchased credits—not subscription spend. Usage may be delayed.</p>
        <h4 class="text-caption">Daily reported USD</h4>
        <svg viewBox={`0 0 ${Math.max(1, trend().length) * 20} 64`} width="100%" height="64" aria-hidden="true">
          <For each={trend()}>{(b, i) => <Show when={b.usd !== undefined} fallback={<path d={`M${i() * 20 + 3},62 h14`} stroke="var(--color-ink-muted)" stroke-dasharray="2 2" />}>
            <rect x={i() * 20 + 3} y={62 - Math.max(1, b.usd! / scale() * 60)} width="14" height={Math.max(1, b.usd! / scale() * 60)} fill={b.partial ? "var(--color-ink-muted)" : "var(--color-ink-2)"} />
          </Show>}</For>
        </svg>
        <ul class="meter-context" style={{ "list-style": "none", padding: "0" }}>
          <For each={trend()}>{(b) => <li title={`${b.from} → ${b.until} UTC`}><span class="text-mono">{b.date}</span> · {reportedMoney(b.usd)}{b.partial ? " · Partial" : ""}</li>}</For>
        </ul>
      </>}</Show>
    </section>}</Show>
    <Show when={!period() && props.p.windows.length === 0 && props.resetDay}>{(c) => <p class="meter-context">Declared subscription reset: {c().day === null ? "Unknown" : `day ${c().day} of each month`} · <ResetDay c={c()} /></p>}</Show>
  </>;
}
