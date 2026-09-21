// The remote session's connection indicator: the head chip, the Session detail pane's status row
// and the sidebar group's dot (spec/01-app-shell.md "Remote connection chip",
// spec/02-session-list.md "Remote sessions"). All three read src/lib/remote-status.ts.

import { createSignal, onCleanup, Show } from "solid-js";
import { type RemoteEntry, type RemoteView, remoteStatusOf, remoteStatusOfTarget, remoteView } from "../lib/remote-status";
import { announce } from "../lib/ui-state";

/** A 1s clock for the ages and running times, alive only while a chip is on screen. */
function useNow() {
  const [now, setNow] = createSignal(Date.now());
  const t = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(t));
  return now;
}

/** "connected · 42s ago", "unreachable · ok 5m ago", "last ok 12m ago": the age always rides along. */
function ageText(v: RemoteView): string | undefined {
  if (!v.age) return undefined;
  if (v.word === "connected") return v.age;
  if (v.word === "last ok") return v.age;
  return v.age === "never" ? "never ok" : `ok ${v.age}`;
}

/** The pane's chip keeps the host's case (.chip-count); the head's is a plain uppercase chip, since
    the head drops every .chip-count child on a narrow head and this one must stay. */
function chipClass(v: RemoteView, extra = "") {
  return `chip${extra ? "" : " chip-count"}${v.tone ? ` chip-${v.tone}` : ""}${v.running ? " chip-live" : ""}${extra ? ` ${extra}` : ""}`;
}

function ChipBody(props: { view: RemoteView; host: boolean }) {
  return (
    <>
      <i class="chip-dot" />
      <span>{props.view.word}</span>
      <Show when={props.host && props.view.host}>
        <span aria-hidden="true">·</span>
        <span>{props.view.host}</span>
      </Show>
      <Show when={props.view.running} fallback={<Show when={ageText(props.view)}>{(a) => <span class="text-num">· {a()}</span>}</Show>}>
        {(r) => <span class="text-num">· {r()}</span>}
      </Show>
    </>
  );
}

/** The session head's chip: state word and host, compact; opens the Session detail pane. */
export function RemoteHeadChip(props: { path: string; onOpen(): void }) {
  const now = useNow();
  const entry = () => remoteStatusOf(props.path);
  return (
    <Show when={entry()}>
      {(e) => {
        const v = () => remoteView(e(), now());
        return (
          <button
            type="button"
            class={chipClass(v(), "remote-head-chip")}
            title={`${v().title}\nOpen Session detail to check or reconnect.`}
            aria-label={`Remote ${e().target}: ${v().word}${v().host ? ` on ${v().host}` : ""}. Open session detail.`}
            onClick={() => props.onOpen()}
          >
            <i class="chip-dot" />
            <span>{v().word}</span>
            {/* Compact: no age, except on an old success, which must not read as current. */}
            <Show when={v().word === "last ok" && v().age}>{(a) => <span>{a()}</span>}</Show>
            <Show when={v().host}>
              <span aria-hidden="true">·</span>
              {/* A host keeps its case inside the uppercase chip. */}
              <span style={{ "text-transform": "none", "letter-spacing": "0" }}>{v().host}</span>
            </Show>
          </button>
        );
      }}
    </Show>
  );
}

/** The Session detail pane's row: the chip with its age, the failure's first line, check-now and reconnect. */
export function RemotePaneStatus(props: { path: string }) {
  const now = useNow();
  const entry = () => remoteStatusOf(props.path);
  // A request in flight: the button says so until the next report lands (or 20s pass).
  const [asked, setAsked] = createSignal<{ kind: "check" | "reconnect"; at: number } | null>(null);
  const waiting = (e: RemoteEntry) => {
    const a = asked();
    return a && (e.receivedAt ?? 0) < a.at && now() - a.at < 20_000 ? a.kind : null;
  };
  const ask = (e: RemoteEntry, kind: "check" | "reconnect") => {
    const ok = kind === "check" ? e.controls?.check() : e.controls?.reconnect();
    if (ok) setAsked({ kind, at: Date.now() });
    else announce("Not connected to pi-web's server; try again once it reconnects.");
  };
  return (
    <Show when={entry()}>
      {(e) => {
        const v = () => remoteView(e(), now());
        return (
          <div class="stack-2" style={{ padding: "var(--space-3) var(--space-4)", "border-bottom": "var(--stroke-thin) solid var(--color-border)" }}>
            <div class="cluster">
              <span class={chipClass(v())} title={v().title}>
                <ChipBody view={v()} host />
              </span>
              <Show when={e().controls}>
                <span class="cluster" style={{ "margin-left": "auto" }}>
                  <button
                    type="button"
                    class="button button-sm button-ghost"
                    disabled={!!waiting(e())}
                    title="Run one round trip to the host now"
                    onClick={() => ask(e(), "check")}
                  >
                    {waiting(e()) === "check" ? "Checking…" : "Check now"}
                  </button>
                  <button
                    type="button"
                    class="button button-sm button-ghost"
                    disabled={!!waiting(e())}
                    title="Drop the fast channel and probe the host again"
                    onClick={() => ask(e(), "reconnect")}
                  >
                    {waiting(e()) === "reconnect" ? "Reconnecting…" : "Reconnect"}
                  </button>
                </span>
              </Show>
            </div>
            <Show when={v().error}>
              {(err) => (
                <p class="text-caption text-error" style={{ margin: 0 }}>
                  {err()}
                </p>
              )}
            </Show>
            {/* The fast channel's own condition (rate-limited): muted, since calls still go through. */}
            <Show when={v().channel}>
              {(c) => (
                <p class="text-caption text-muted" style={{ margin: 0 }}>
                  Fast channel {c()}
                </p>
              )}
            </Show>
          </div>
        );
      }}
    </Show>
  );
}

/** The sidebar group's dot for a target: a state, not a live session, so it sits after the label
    and never pulses (the pulse is the live-session dot's). Absent while no chat reports on it. */
export function RemoteGroupDot(props: { target: string }) {
  const now = useNow();
  const entry = () => remoteStatusOfTarget(props.target);
  return (
    <Show when={entry()}>
      {(e) => {
        const v = () => remoteView(e(), now());
        return (
          <span
            class={`chip-dot${v().tone ? ` chip-${v().tone}` : ""}`}
            style={{ width: "6px", height: "6px" }}
            role="img"
            aria-label={`connection: ${v().word}`}
            title={`Connection: ${v().word}\n${v().title}`}
          />
        );
      }}
    </Show>
  );
}
