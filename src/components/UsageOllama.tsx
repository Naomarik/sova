import { createSignal, For, onCleanup, Show } from "solid-js";
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

/** The daily chart's height, its widest bar pitch and the narrowest. */
const DAILY_H = 64;
const DAILY_PITCH_MAX = 32;
const DAILY_PITCH_MIN = 4;

/**
 * "Daily reported USD" as bars (§app.insights/ollama-activity): measured to its block's width, a
 * fixed pitch from the left edge, partial days muted, a missing amount a dashed base. Before it is
 * measured (and on the server) it draws at the widest pitch. `aria-hidden`: the date list under it
 * carries the figures.
 */
function DailyBars(props: { days: ReturnType<typeof activityTrend> }) {
  const [width, setWidth] = createSignal(0);
  const measure = (el: HTMLDivElement) => {
    const ro = new ResizeObserver(() => setWidth(Math.floor(el.clientWidth)));
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  };
  const n = () => Math.max(1, props.days.length);
  const pitch = () => (width() > 0 ? Math.max(DAILY_PITCH_MIN, Math.min(DAILY_PITCH_MAX, Math.floor(width() / n()))) : DAILY_PITCH_MAX);
  const bar = () => Math.max(2, pitch() - Math.max(1, Math.round(pitch() * 0.3)));
  const scale = () => Math.max(0.01, ...props.days.map((b) => b.usd ?? 0));
  const height = (usd: number) => Math.max(1, (usd / scale()) * (DAILY_H - 4));
  return (
    <div ref={measure} class="usage-daily">
      <svg class="usage-daily-bars" width={n() * pitch()} height={DAILY_H} viewBox={`0 0 ${n() * pitch()} ${DAILY_H}`} aria-hidden="true">
        <For each={props.days}>
          {(b, i) => (
            <Show when={b.usd !== undefined} fallback={<path class="usage-daily-gap" d={`M${i() * pitch()},${DAILY_H - 2} h${bar()}`} />}>
              <rect
                class="usage-daily-bar"
                classList={{ "usage-daily-bar-partial": b.partial }}
                x={i() * pitch()}
                y={DAILY_H - 1 - height(b.usd!)}
                width={bar()}
                height={height(b.usd!)}
              />
            </Show>
          )}
        </For>
      </svg>
    </div>
  );
}

/** "{from} → {until} UTC": each bound on one line, so a wrap falls at the arrow. */
function Period(props: { from: string; until: string }) {
  return (
    <>
      <span class="usage-period">{props.from}</span> → <span class="usage-period">{props.until}</span> UTC
    </>
  );
}

/**
 * Ollama's lines (§app.insights/ollama-credits, §app.insights/ollama-activity): included credits
 * and activity, each a meter block and a trend block, then the declared reset when it applies.
 * Its sources are separate from quota windows and the device's API-price ledger.
 */
export function OllamaLines(props: { p: UsageProvider; now: number; resetDay?: ResetDayControl }) {
  const activity = () => props.p.activity;
  const credits = () => props.p.credits;
  const period = () => credits()?.data?.included?.period;
  const previousCredits = () => endpointPrevious(credits(), props.now) || (!!period() && (Date.parse(period()!.from) > props.now || Date.parse(period()!.until) <= props.now));
  const time = (t: number | undefined) => (t === undefined ? "time unknown" : new Date(t).toISOString());
  const trend = () => (activity()?.data ? activityTrend(activity()!.data!) : []);
  return (
    <>
      <Show
        when={credits()}
        fallback={
          <section class="usage-credits stack stack-2" aria-labelledby="u-ollama-credits">
            <h3 id="u-ollama-credits" class="text-heading-s">Included credits</h3>
            <p class="meter-context">No balance reading yet.</p>
            <div class="usage-credit-figures">
              <p class="meter-head"><span class="meter-label">Included remaining</span><span class="meter-value">Unknown</span></p>
              <p class="meter-head"><span class="meter-label">Included allowance</span><span class="meter-value">Unknown</span></p>
              <p class="meter-head"><span class="meter-label">Purchased remaining</span><span class="meter-value">Unknown</span></p>
            </div>
          </section>
        }
      >
        {(r) => (
          <section class="usage-credits stack stack-2" aria-labelledby="u-ollama-credits">
            <div class="usage-line-meter stack stack-2">
              <h3 id="u-ollama-credits" class="text-heading-s">Included credits</h3>
              <p class="usage-caption text-caption text-muted">
                {previousCredits() ? "Previous reading · as of " : "As of "}
                <span class="usage-period">{time(r().fetchedAt)}</span>
                <Show when={r().error}> · {r().error}</Show>
              </p>
              <div class="meter">
                <div class="usage-credit-figures">
                  <p class="meter-head"><span class="meter-label">Included remaining</span><span class="meter-value">{reportedMoney(r().data?.included?.balance_usd)}</span></p>
                  <p class="meter-head"><span class="meter-label">Included allowance</span><span class="meter-value">{reportedMoney(r().data?.included?.allowance_usd)}</span></p>
                  <p class="meter-head"><span class="meter-label">Purchased remaining</span><span class="meter-value">{reportedMoney(r().data?.purchased?.balance_usd)}</span></p>
                </div>
                <Show when={includedCreditPct(r().data) !== undefined}>
                  <p class="meter-context">{Math.round(includedCreditPct(r().data)!)}% included credits used</p>
                  <Show when={currentIncluded(props.p, props.now)}>
                    <div class="meter-track usage-credit-meter" aria-hidden="true">
                      <span class="meter-fill" style={{ "--meter-pct": `${includedCreditPct(r().data)}%` }} />
                    </div>
                  </Show>
                </Show>
                <Show when={period()} fallback={<p class="meter-context">Included period: Unknown</p>}>
                  {(p) => (
                    <p class="meter-context text-mono">
                      <Period from={p().from} until={p().until} /> · end exclusive
                    </p>
                  )}
                </Show>
              </div>
            </div>
            <div class="usage-line-trend">
              <For each={(["session", "weekly"] as const).filter((k) => r().data?.[k])}>
                {(k) => (
                  <p class="meter-context">
                    {k === "session" ? "Session" : "Weekly"}: {r().data![k]!.remaining_percent}% remaining
                    <Show when={r().data![k]!.resets_at}> · resets {r().data![k]!.resets_at}</Show>
                  </p>
                )}
              </For>
            </div>
          </section>
        )}
      </Show>
      <Show when={activity()}>
        {(r) => (
          <section class="usage-line usage-activity" aria-labelledby="u-ollama-activity">
            <header class="usage-line-head stack stack-2">
              <h3 id="u-ollama-activity" class="text-heading-s">Activity</h3>
              <p class="usage-caption text-caption text-muted">
                {endpointPrevious(r(), props.now) ? "Previous reading · as of " : "As of "}
                <span class="usage-period">{time(r().fetchedAt)}</span>
                <Show when={r().error}> · {r().error}</Show>
              </p>
              <Show when={r().data}>
                {(a) => <p class="meter-context text-mono"><Period from={a().from} until={a().until} /> · end exclusive · {a().scope}</p>}
              </Show>
            </header>
            <Show when={r().data}>
              {(a) => <div class="usage-line-meter stack stack-2">
                <For each={activityMetrics(a())}>{(m) => <p class="meter-head"><span class="meter-label">{m.label}</span><span class="meter-value">{m.value}</span></p>}</For>
                <p class="meter-context">Request value, including plan and purchased credits—not subscription spend. Usage may be delayed.</p>
              </div>}
            </Show>
            <Show when={r().data}>
              <div class="usage-line-trend">
                <h4 class="text-caption">Daily reported USD</h4>
                <DailyBars days={trend()} />
                <ul class="meter-context usage-daily-list">
                  <For each={trend()}>
                    {(b) => (
                      <li title={`${b.from} → ${b.until} UTC`}>
                        <span class="text-mono">{b.date}</span> · {reportedMoney(b.usd)}
                        {b.partial ? " · Partial" : ""}
                      </li>
                    )}
                  </For>
                </ul>
              </div>
            </Show>
          </section>
        )}
      </Show>
      <Show when={!period() && props.p.windows.length === 0 && props.resetDay}>
        {(c) => (
          <div class="meter-context usage-declared-reset">
            Declared subscription reset: {c().day === null ? "Unknown" : `day ${c().day} of each month`} · <ResetDay c={c()} />
          </div>
        )}
      </Show>
    </>
  );
}
