// The remote session's chips: the always-on identity chip and the mount state (pane + head), the
// connection chip (head + pane row), the pane's check/reconnect controls and mount toggle, and the
// sidebar group's connection dot (spec/01-app-shell.md "Remote session chips",
// spec/02-session-list.md "Remote sessions"). All read src/lib/remote-status.ts.

import { createSignal, onCleanup, Show } from "solid-js";
import type { SessionSummary } from "../../shared/protocol";
import { fetchTargets, mountTarget } from "../lib/api";
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
// The remote chip names the target by its label, and the mount toggle reads its live mount state.
// The fetch is shared and idempotent; a failure falls back to the target name, which is a true
// label too, and leaves the mount toggle absent rather than guessing.

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
/** Replace one target's cached record with a fresh one — the mount endpoints return it.
    **Exported because every mount action must update this same store.** A caller that discards
    the response leaves the mounted chip showing a stale "not mounted" after a successful mount
    (the open-failure banner's Mount-and-reconnect did exactly that). */
export const patchTarget = (t: TargetInfo) => setTargets((list) => list.map((x) => (x.name === t.name ? t : x)));

/** The target's live mount state: the server's bounded check (fresh, and refreshed by the mount
    toggle), else the extension's report for this chat. `undefined` when nothing is known (or the
    target has no mount config). */
function liveMountedOf(target: string, entry: RemoteEntry | undefined): boolean | undefined {
  const server = targetInfoOf(target)?.mounted;
  return server !== undefined ? server : entry?.status?.mounted;
}

// A path in the chip keeps its case and truncates rather than pushing the chip wide.
const PATH_STYLE = { "text-transform": "none", "letter-spacing": "0", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" } as const;

/**
 * The always-on remote chip: this session is remote, and where its files are. Fed by the summary's
 * `target`/`remoteCwd` (and `mounted`), so it exists the moment the session does — before any
 * status, and for a watched or TUI-owned session with no chat socket at all. It is the identity,
 * never the connection: a mount-mode session (`SessionSummary.mounted`) shows its local mount cwd,
 * where the files actually are; a plain remote session shows the folder on the target. `pane` is a
 * `.chip-count`; the head's plain chip survives the narrow-head `.chip-count` rule, so the fact
 * never disappears.
 */
export function RemoteChip(props: { path: string; summary: SessionSummary | undefined; pane?: boolean }) {
  ensureTargets();
  const id = () => remoteIdentity(props.summary ?? { cwd: "" }, remoteStatusOf(props.path));
  const title = (r: NonNullable<ReturnType<typeof id>>) => {
    const host = targetHost(r.target);
    const remote = host ? `${r.target} (${host}):${r.remoteCwd}` : `${r.target}:${r.remoteCwd}`;
    const local = r.sessionMounted ? ` The session's files are the mount, at ${r.path}.` : "";
    const live = liveMountedOf(r.target, remoteStatusOf(props.path));
    const mount =
      live === true
        ? r.mountPoint
          ? ` Mounted at ${r.mountPoint}.`
          : " The target's mount is up."
        : live === false
        ? " The mount is configured but not currently up."
        : "";
    return `Remote: ${remote}.${local}${mount}`;
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

/**
 * The mount state indicator: a mount-mode session is always shown (identity); a plain remote
 * session appears only once the live state says the target's mount is up. The word is the honest
 * live state — `mounted` only when the extension or the server's bounded check says so, `not
 * mounted` when the session is a mount session and that check says down, `mount` while nothing has
 * been checked. Neutral on purpose: a mount is a state, not health, and a hung mount must never
 * read green. A `.chip-count`, so a narrow head hides it; the remote chip still names the path
 * there, so the fact survives.
 */
export function RemoteMountedChip(props: { path: string; summary: SessionSummary | undefined; pane?: boolean }) {
  const id = () => remoteIdentity(props.summary ?? { cwd: "" }, remoteStatusOf(props.path));
  const live = () => {
    const r = id();
    return r ? liveMountedOf(r.target, remoteStatusOf(props.path)) : undefined;
  };
  const show = () => !!id()?.sessionMounted || live() === true;
  const word = () => (live() === true ? "mounted" : live() === false ? "not mounted" : "mount");
  // The live mount root, when a chat here reported one. Without it the remote chip already shows
  // where the session's files are (its local mount cwd), so the indicator need not repeat it.
  const where = () => id()?.mountPoint;
  const title = (r: NonNullable<ReturnType<typeof id>>) => {
    const l = live();
    const at = where();
    if (l === true) return at ? `The target's sshfs mount is up, at ${at}.` : "The target's sshfs mount is up.";
    if (l === false) return `This session runs in the target's mount, and the mount is not up right now.${at ? ` It mounts at ${at}.` : ""}`;
    return `This session runs in the target's mount.${at ? ` It mounts at ${at}.` : ""} Its state hasn't been checked.`;
  };
  return (
    <Show when={id()}>
      {(r) => (
        <Show when={show()}>
          <span class={`chip${props.pane ? " chip-count" : ""} mounted-chip`} title={title(r())}>
            <i class="chip-dot" />
            <span>{word()}</span>
            <Show when={props.pane && where()}>
              {(at) => (
                <>
                  <span aria-hidden="true">·</span>
                  <span class="text-mono" style={{ ...PATH_STYLE, "max-width": "30ch" }}>
                    {at()}
                  </span>
                </>
              )}
            </Show>
          </span>
        </Show>
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

/** The Session detail pane's row: the remote chip and mount state (always), the connection chip with
    its age, the failure's first line, the mount toggle and check-now / reconnect. */
export function RemotePaneStatus(props: { path: string; summary: SessionSummary | undefined }) {
  ensureTargets();
  const now = useNow();
  const entry = () => remoteStatusOf(props.path);
  const view = () => {
    const e = entry();
    return e ? remoteView(e, now()) : null;
  };
  const identity = () => remoteIdentity(props.summary ?? { cwd: "" }, entry());
  const target = () => {
    const r = identity();
    return r ? targetInfoOf(r.target) : undefined;
  };
  /** The target declares a mount config: `mounted` is present (true up, false configured-down). */
  const canMount = () => target()?.mounted !== undefined;
  const [toggling, setToggling] = createSignal(false);
  const [mountError, setMountError] = createSignal<string | null>(null);
  const toggleMount = async () => {
    const t = target();
    if (!t || t.mounted === undefined || toggling()) return;
    setToggling(true);
    setMountError(null);
    try {
      patchTarget(await mountTarget(t.name, !t.mounted));
    } catch (err) {
      // A caption under the row, never a toast-only: the fact must stay on screen.
      setMountError((err as Error).message);
    } finally {
      setToggling(false);
    }
  };
  // A request in flight: the check/reconnect button says so until the next report lands (or 20s pass).
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
    <Show when={identity()}>
      {(r) => (
        <div class="stack-2" style={{ padding: "var(--space-3) var(--space-4)", "border-bottom": "var(--stroke-thin) solid var(--color-border)" }}>
          <div class="cluster">
            <RemoteChip path={props.path} summary={props.summary} pane />
            <RemoteMountedChip path={props.path} summary={props.summary} pane />
            <Show when={view()}>
              {(v) => (
                <span class={chipClass(v())} title={v().title}>
                  <ChipBody view={v()} host />
                </span>
              )}
            </Show>
            <span class="cluster" style={{ "margin-left": "auto" }}>
              <Show when={canMount()}>
                <button
                  type="button"
                  class="button button-sm button-ghost"
                  disabled={toggling()}
                  title={target()?.mounted ? "Unmount the target's sshfs mount" : "Mount the target's folder over sshfs; new sessions can then use the real files"}
                  onClick={() => void toggleMount()}
                >
                  {toggling() ? (target()?.mounted ? "Unmounting…" : "Mounting…") : target()?.mounted ? "Unmount" : "Mount"}
                </button>
              </Show>
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
          <Show when={mountError()}>
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
