// The remote session's chips: the always-on identity chip (pane + head), the connection chip
// (head + pane row), the pane's check/reconnect controls, and the sidebar group's connection dot
// (spec/01-app-shell.md "Remote session chips", spec/02-session-list.md "Remote sessions"). All
// read src/lib/remote-status.ts.

import { createSignal, onCleanup, Show } from "solid-js";
import type { SessionSummary } from "../../shared/protocol";
import { fetchTargets } from "../lib/api";
import { type RemoteEntry, type RemoteView, remoteIdentity, remoteStatusOf, remoteStatusOfTarget, remoteView } from "../lib/remote-status";
import { type TargetInfo } from "../lib/remote-session";
import { announce } from "../lib/ui-state";
import { Icon } from "./ui";

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

// ---- Targets: one /api/targets for the whole tab -------------------------------------------------
// The remote chip names the target by its label. The fetch is shared and idempotent; a failure
// falls back to the target name, which is a true label too.

const [targets, setTargets] = createSignal<TargetInfo[]>([]);
let targetsOnce: Promise<void> | null = null;
function ensureTargets() {
  targetsOnce ??= fetchTargets()
    .then((list) => {
      setTargets(list);
    })
    .catch(() => {});
}
const targetInfoOf = (name: string) => targets().find((t) => t.name === name);
const targetLabel = (name: string) => targetInfoOf(name)?.label || name;
const targetHost = (name: string) => targetInfoOf(name)?.host;

// A path in the chip keeps its case and truncates rather than pushing the chip wide.
const PATH_STYLE = { "text-transform": "none", "letter-spacing": "0", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" } as const;

/**
 * The always-on remote chip: this session is remote, and where its files are. Fed by the summary's
 * `target`/`remoteCwd`, so it exists the moment the session does — before any status, and for a
 * watched or TUI-owned session with no chat socket at all. It is the identity, never the
 * connection: it shows the folder on the target. `pane` is a `.chip-count`; the head's plain chip
 * survives the narrow-head `.chip-count` rule, so the fact never disappears.
 */
export function RemoteChip(props: { path: string; summary: SessionSummary | undefined; pane?: boolean }) {
  ensureTargets();
  const id = () => remoteIdentity(props.summary ?? { cwd: "" });
  const title = (r: NonNullable<ReturnType<typeof id>>) => {
    const host = targetHost(r.target);
    return `Remote: ${host ? `${r.target} (${host}):${r.remoteCwd}` : `${r.target}:${r.remoteCwd}`}.`;
  };
  return (
    <Show when={id()}>
      {(r) => (
        <span class={`chip remote-chip${props.pane ? " chip-count" : ""}`} title={title(r())}>
          <Icon name="terminal" small />
          <span style={PATH_STYLE}>{targetLabel(r().target)}</span>
          <span aria-hidden="true">·</span>
          <span class="text-mono" style={{ ...PATH_STYLE, "max-width": props.pane ? "30ch" : "18ch" }}>
            {r().path}
          </span>
        </span>
      )}
    </Show>
  );
}

/** The session head's connection chip: state word and host, compact; opens the Session detail pane. */
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

/** The Session detail pane's row: the remote chip (always), the connection chip with its age, the
    failure's first line, and check-now / reconnect. */
export function RemotePaneStatus(props: { path: string; summary: SessionSummary | undefined }) {
  ensureTargets();
  const now = useNow();
  const entry = () => remoteStatusOf(props.path);
  const view = () => {
    const e = entry();
    return e ? remoteView(e, now()) : null;
  };
  const identity = () => remoteIdentity(props.summary ?? { cwd: "" });
  // A request in flight: the check/reconnect button says so until the next report lands (or 20s pass).
  const [asked, setAsked] = createSignal<{ kind: "check" | "reconnect"; at: number } | null>(null);
  const waiting = (e: RemoteEntry) => {
    const a = asked();
    return a && (e.receivedAt ?? 0) < a.at && now() - a.at < 20_000 ? a.kind : null;
  };
  const ask = (e: RemoteEntry, kind: "check" | "reconnect") => {
    const ok = kind === "check" ? e.controls?.check() : e.controls?.reconnect();
    if (ok) setAsked({ kind, at: Date.now() });
    else announce("Not connected to Sova's server; try again once it reconnects.");
  };
  return (
    <Show when={identity()}>
      {(r) => (
        <div class="stack-2" style={{ padding: "var(--space-3) var(--space-4)", "border-bottom": "var(--stroke-thin) solid var(--color-border)" }}>
          <div class="cluster">
            <RemoteChip path={props.path} summary={props.summary} pane />
            <Show when={view()}>
              {(v) => (
                <span class={chipClass(v())} title={v().title}>
                  <ChipBody view={v()} host />
                </span>
              )}
            </Show>
            <span class="cluster" style={{ "margin-left": "auto" }}>
              <Show when={entry()?.controls}>
                <button
                  type="button"
                  class="button button-sm button-ghost"
                  disabled={!!waiting(entry()!)}
                  title="Run one round trip to the host now"
                  onClick={() => ask(entry()!, "check")}
                >
                  {waiting(entry()!) === "check" ? "Checking…" : "Check now"}
                </button>
                <button
                  type="button"
                  class="button button-sm button-ghost"
                  disabled={!!waiting(entry()!)}
                  title="Drop the fast channel and probe the host again"
                  onClick={() => ask(entry()!, "reconnect")}
                >
                  {waiting(entry()!) === "reconnect" ? "Reconnecting…" : "Reconnect"}
                </button>
              </Show>
            </span>
          </div>
          <Show when={view()?.error}>
            {(err) => (
              <p class="text-caption text-error" style={{ margin: 0 }}>
                {err()}
              </p>
            )}
          </Show>
          {/* The fast channel's own condition (rate-limited): muted, since calls still go through. */}
          <Show when={view()?.channel}>
            {(c) => (
              <p class="text-caption text-muted" style={{ margin: 0 }}>
                Fast channel {c()}
              </p>
            )}
          </Show>
        </div>
      )}
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
