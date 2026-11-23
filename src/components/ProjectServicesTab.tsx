import { createMemo, createSignal, For, type JSX, onMount, Show } from "solid-js";
import type { ProjectRuntimeView } from "../../shared/project-runtime";
import type { LinkView, VerbResult } from "../../shared/project-contract";
import { type CopyLimitView, type CopyView, isStarting, type ServiceRowView } from "../../shared/services-view";
import { ApiError, getProjectRuntime, getProjectServices, runProjectVerb, runProjectVerbsPlaybook, setCopyLimit } from "../lib/api";
import { relativeTime } from "../lib/format";
import { canGoCount, copyGroups, freeButton, freedLine, freeTitle, goWord, type GoReason, inUseCount, type LandedCopies, NO_LANDED } from "../lib/free-slots";
import { memoryWord, notSetUpWords, openWord, playbookLabel, portsWord, reviewDefProblem, reviewProofWord, runStrip, runWord, SENSITIVE_TITLE, serviceFacts, setupStatus, setupStepsWord, shareWord, testsWord } from "../lib/project-software";
import { projectSessionHref } from "../lib/projects-route";
import { createPoll, type Poll } from "../lib/poll";
import {
  adoptedLine,
  ARCHIVED_COPIES_LINE,
  archivedVerbs,
  ASKS_FIRST,
  confirmLabel,
  copyChip,
  copyMemory,
  copyName,
  costLine,
  createdByWord,
  DESTRUCTIVE,
  doneLine,
  entryHref,
  entryTitle,
  failedBlocks,
  gaveUp,
  httpHref,
  limitHint,
  limitInputProblem,
  limitLine,
  placesLine,
  limitSource,
  memoryOf,
  usableLine,
  notReadyLine,
  openEntry,
  portLabel,
  refusalLine,
  restarting,
  rowVerbs,
  type RowVerb,
  SERVICE_CHIP,
  START_AGAIN,
  SHARE_DAY_CHOICES,
  SHARE_SENSITIVE,
  endpointNotRunning,
  endpointPort,
  linkLine,
  shareBlocked,
  shareOffered,
  VERB_LABEL,
  VERB_RUNNING,
  verbGroups,
} from "../lib/services-view";
import { previewWarning } from "../lib/previews";
import { COPY_LINK_GONE, copyLinkDeleted, DELETE_ASK, DELETE_LINK, DELETING } from "../lib/link-delete";
import { createArm } from "../lib/two-step";
import "../delete-button.css";
import { announce, copyText, toast } from "../lib/ui-state";
import { MergeRunButton, proposedRun } from "./PlaybookReview";
import { PreviewsCard } from "./PreviewsCard";
import { DeployRecipeSteps } from "./ProjectDeployPanel";
import { ReleaseSetupSteps } from "./ReleasesTab";
import { ServiceLogsDrawer } from "./ServiceLogsDrawer";
import { Chip, Icon, Placeholder, trapFocus } from "./ui";

const POLL_MS = 5_000;
const errText = (x: unknown) => (x instanceof ApiError || x instanceof Error ? x.message : String(x));
/** The registry changes on a merge, a conformance or a run: read it often enough to follow one. */
const RUNTIME_POLL_MS = 15_000;
/** Recent's lines, newest first. */
const RECENT_SHOWN = 10;

/** The page's one read of the software registry: Running Copies' setup line and the proposed run's banner share it. */
export const createRuntimePoll = (projectId: string): Poll<ProjectRuntimeView> => createPoll(() => getProjectRuntime(projectId), RUNTIME_POLL_MS, { cacheKey: `project:${projectId}:runtime` });

/** A live run's state chip: working is the live indicator; waiting on you is warn. */
const STRIP_TONE: Record<string, "accent" | "warn" | "info" | undefined> = { Working: "accent", "Waiting for your answers": "warn", Proposed: "info", Idle: undefined };

/**
 * A service's ports as one compact tag (its name, then each port), each port with HTTP readiness a
 * link on the host this page was opened from. `named` leads with the service's name.
 */
function Ports(props: { service: ServiceRowView; named?: boolean }) {
  const entries = () => Object.entries(props.service.ports);
  return (
    <Show when={entries().length}>
      <span class="services-svc">
        <Show when={props.named}>
          <span class="services-svc-name">{props.service.name}</span>
        </Show>
        <For each={entries()}>
          {([name, port]) => (
            <span class="text-mono services-port">
              <Show when={props.service.http?.port === port} fallback={portLabel(name, port)}>
                <a href={httpHref(location.hostname, { port, path: "/" })} target="_blank" rel="noopener" title={`Open ${props.service.name} on port ${port}`}>
                  {portLabel(name, port)}
                </a>
              </Show>
            </span>
          )}
        </For>
      </span>
    </Show>
  );
}

/**
 * The copy limit (§app.project-services/services-ui): how many copies there are and run, the limit in force and
 * where it comes from, with Change (an inline editor: a number, Save, Cancel, Reset to File's Value); the
 * over-limit sentence while more run than it allows; and what the copies cost in memory, warning when the
 * copies at the limit need more than this machine has available now.
 */
function CopyLimit(props: { projectId: string; limit: CopyLimitView; archived: boolean; changed: () => void }) {
  const [editing, setEditing] = createSignal(false);
  const [text, setText] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const open = () => {
    setText(String(props.limit.value));
    setError(null);
    setEditing(true);
  };
  const save = async (cap: number | null) => {
    if (busy()) return;
    if (cap !== null) {
      const why = limitInputProblem(text());
      if (why) return setError(why);
    }
    setBusy(true);
    setError(null);
    try {
      const r = await setCopyLimit(props.projectId, cap);
      const done = r.limit.source === "machine" ? `Up to ${r.limit.value} copies run at once on this machine.` : `The project's file sets the limit again: up to ${r.limit.value} at once.`;
      toast(done);
      announce(done);
      setEditing(false);
      props.changed();
    } catch (x) {
      setError(errText(x));
    } finally {
      setBusy(false);
    }
  };
  const cost = () => costLine(props.limit);
  return (
    <div class="services-limit">
      <Show
        when={editing()}
        fallback={
          <p class="orgs-line services-limit-line">
            <span class="services-limit-words">
              <strong class="services-limit-count">{limitLine(props.limit).split(" · ")[0]}</strong>{" "}
              <span class="services-limit-source">
                · {limitLine(props.limit).split(" · ").slice(1).join(" · ")}, {limitSource(props.limit)}
              </span>
            </span>
            <Show when={!props.archived}>
              <button type="button" class="button button-sm" onClick={open}>
                Change
              </button>
            </Show>
          </p>
        }
      >
        <form
          class="services-limit-form"
          novalidate
          onSubmit={(e) => {
            e.preventDefault();
            void save(Number(text().trim()));
          }}
        >
          <div class="field">
            <label class="field-label" for={`copy-limit-${props.projectId}`}>
              Copies at once on this machine
            </label>
            <input
              id={`copy-limit-${props.projectId}`}
              class="input services-limit-input"
              type="number"
              inputmode="numeric"
              min="1"
              max="16"
              step="1"
              value={text()}
              aria-invalid={error() ? "true" : undefined}
              aria-describedby={`copy-limit-hint-${props.projectId}`}
              onInput={(e) => setText(e.currentTarget.value)}
            />
            <p class="field-hint" id={`copy-limit-hint-${props.projectId}`}>
              {limitHint(props.limit)}
            </p>
            <Show when={error()}>{(e) => <p class="field-error">{e()}</p>}</Show>
          </div>
          <div class="button-row">
            <button type="submit" class="button button-sm button-primary" aria-disabled={busy() ? "true" : undefined}>
              {busy() ? "Saving…" : "Save"}
            </button>
            <button type="button" class="button button-sm button-ghost" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <Show when={props.limit.source === "machine"}>
              <button type="button" class="button button-sm button-ghost" onClick={() => void save(null)}>
                Reset to File's Value
              </button>
            </Show>
          </div>
        </form>
      </Show>
      {/* The copies against the places they can use: the line above carries the numbers. */}
      <Show when={!editing() && props.limit.usable > 0}>
        <div class="meter-track services-limit-meter" aria-hidden="true">
          <span class="meter-fill" style={{ "--meter-pct": `${Math.min(100, Math.round((props.limit.copies / props.limit.usable) * 100))}%` }} />
        </div>
      </Show>
      <Show when={props.limit.over}>{(o) => <p class="banner banner-warn services-limit-over">{o()}</p>}</Show>
      <Show when={usableLine(props.limit)}>{(u) => <p class="field-hint services-limit-places">{u()}</p>}</Show>
      <For each={props.limit.unavailable ?? []}>{(line) => <p class="field-hint services-limit-places">{line}</p>}</For>
      <Show when={props.limit.places}>{(places) => <p class="field-hint services-limit-places">{placesLine({ usable: props.limit.usable, places: places() })}</p>}</Show>
      <p class={`field-hint services-limit-cost${cost().warn ? " services-limit-cost-warn" : ""}`}>{cost().text}</p>
    </div>
  );
}

/**
 * A project's Running Copies tab (§app.project-services/services-ui), once Branches: the copy limit and the
 * services' setup line (Set Up with a Chat or Change Setup…, a live run, a proposed run's review), then one row per copy on
 * this host in two groups, In use and Can go (landed, or left stopped by the merge queue; Free Up Slots tears
 * those down at once, asked first), Previews, the shared services, and the registry's Recent feed, closed. The
 * main checkout's first, each with its ports, memory, state and who made it, Open (its app's entry, while
 * the entry's service is ready) first, and Start, Stop, Logs and Teardown run as the operator (Apply and Reset are
 * not on the page: a chat runs them with its own tools); the shared services in their own block.
 * Teardown (and Stop of a shared service) asks first; a refusal reads as a sentence under its row.
 */
export function ProjectServicesTab(props: {
  projectId: string;
  archived: boolean;
  /** The page's one read of the software registry (the setup line, a live or proposed run, Recent). */
  runtime: Poll<ProjectRuntimeView>;
  /** What the page knows landed (free-slots.ts landedCopies): Can go's copies. Absent: only the merge queue's copy can go. */
  landed?: () => LandedCopies;
}) {
  const poll = createPoll(() => getProjectServices(props.projectId), POLL_MS);
  /** `<instance or service>:<verb>` of the verb in flight. */
  const [running, setRunning] = createSignal<string | null>(null);
  /** The button whose next click confirms. */
  /** A verb's or link's first press arms it; a link's Delete line goes away only after the press that left it lands. */
  const arming = createArm<string>();
  const armed = arming.armed;
  const setArmed = (key: string | null) => (key === null ? arming.reset() : arming.arm(key));
  /** The sentence under each row (by instance, or `shared:<name>`). */
  const [said, setSaid] = createSignal<Record<string, string>>({});
  const [logs, setLogs] = createSignal<{ instance: string; name: string } | null>(null);

  const say = (row: string, line: string | null) => {
    const next = { ...said() };
    if (line) next[row] = line;
    else delete next[row];
    setSaid(next);
  };

  /**
   * Run one verb on a row. A button that asks first arms on its first click; `needs-confirm` arms it
   * too, so the next click sends the confirm.
   */
  const run = async (row: string, verb: RowVerb, name: string, body: Record<string, unknown>, asksFirst: boolean) => {
    const key = `${row}:${verb}`;
    if (running()) return;
    const confirmed = armed() === key;
    if (asksFirst && !confirmed) return setArmed(key);
    setArmed(null);
    setRunning(key);
    say(row, null);
    let r: VerbResult;
    try {
      r = await runProjectVerb(props.projectId, verb, { ...body, ...(confirmed ? { confirm: true } : {}) });
    } catch (x) {
      say(row, `Couldn't reach the engine. ${errText(x)}`);
      setRunning(null);
      return;
    }
    setRunning(null);
    const why = refusalLine(r);
    if (why) {
      say(row, why);
      announce(why);
      if (r.error?.code === "needs-confirm") setArmed(key);
    } else {
      const done = doneLine(verb, name);
      toast(done);
      announce(done);
    }
    poll.refetch();
  };

  /** One verb's button: `quiet` draws it as a ghost; a destructive verb is always outlined in error. */
  const VerbButton = (p: { row: string; verb: RowVerb; name: string; body: Record<string, unknown>; asksFirst?: boolean; label?: string; quiet?: boolean }) => {
    const key = () => `${p.row}:${p.verb}`;
    const destructive = () => DESTRUCTIVE.has(p.verb);
    return (
      <button
        type="button"
        class="button button-sm"
        classList={{ "button-destructive": destructive(), "button-ghost": !!p.quiet && !destructive() }}
        aria-disabled={running() ? "true" : undefined}
        onClick={() => void run(p.row, p.verb, p.name, p.body, !!p.asksFirst)}
        onBlur={() => armed() === key() && setArmed(null)}
      >
        {running() === key() ? VERB_RUNNING[p.verb] : armed() === key() ? confirmLabel(p.verb) : (p.label ?? VERB_LABEL[p.verb])}
      </button>
    );
  };

  const copies = () => poll.data()?.copies ?? [];
  const hasMain = () => copies().some((c) => c.slot === 0);

  // ---- Share (§app.project-services/share) --------------------------------------------------------
  /** The copy whose Share form is open. */
  const [shareOpen, setShareOpen] = createSignal<string | null>(null);
  const [endpoint, setEndpoint] = createSignal("");
  const [days, setDays] = createSignal<number>(SHARE_DAY_CHOICES[0]);
  /** Links minted in this page, by id: copyable even when the status keeps no URL. */
  const [minted, setMinted] = createSignal<Record<string, string>>({});
  const urlOf = (l: LinkView) => l.url ?? minted()[l.id] ?? null;
  const copyLink = (url: string) => void copyText(url, "Link copied.");

  const openShare = (c: CopyView) => {
    setShareOpen(shareOpen() === c.instance ? null : c.instance);
    setEndpoint(c.share.endpoints[0] ?? "");
    setDays(SHARE_DAY_CHOICES[0]);
    say(c.instance, null);
  };
  const share = async (e: Event, c: CopyView) => {
    e.preventDefault();
    const key = `${c.instance}:share`;
    if (running() || !endpoint() || endpointNotRunning(c, endpoint())) return;
    setRunning(key);
    say(c.instance, null);
    try {
      const r = await runProjectVerb(props.projectId, "share", { instance: c.instance, endpoint: endpoint(), days: days(), confirm: true });
      const why = refusalLine(r);
      if (why) {
        say(c.instance, why);
        announce(why);
      } else {
        const link = r.links[0];
        if (link?.url) {
          setMinted({ ...minted(), [link.id]: link.url });
          copyLink(link.url);
        }
        setShareOpen(null);
        const done = `Shared ${endpoint()} of ${copyName(c)}.`;
        toast(done);
        announce(done);
      }
    } catch (x) {
      say(c.instance, `Couldn't reach the engine. ${errText(x)}`);
    } finally {
      setRunning(null);
      poll.refetch();
    }
  };
  /** Delete one link, for good: a second click confirms. */
  const revoke = async (c: CopyView, l: LinkView) => {
    const key = `${l.id}:revoke`;
    if (running()) return;
    if (armed() !== key) {
      setArmed(key);
      announce(COPY_LINK_GONE);
      return;
    }
    setArmed(null);
    setRunning(key);
    try {
      const r = await runProjectVerb(props.projectId, "revoke", { link: l.id });
      const why = refusalLine(r);
      if (why) say(c.instance, why);
      else toast(copyLinkDeleted(l.endpoint, copyName(c)));
    } catch (x) {
      say(c.instance, `Couldn't reach the engine. ${errText(x)}`);
    } finally {
      setRunning(null);
      poll.refetch();
    }
  };

  /** Share on a copy's row: disabled with its reason while the copy can't be shared. */
  const ShareButton = (p: { copy: CopyView }) => {
    const blocked = () => shareBlocked(p.copy, !!poll.data()?.sensitive);
    return (
      <Show when={shareOffered(p.copy) && (p.copy.share.endpoints.length || blocked() === SHARE_SENSITIVE)}>
        <button
          type="button"
          class="button button-sm button-ghost"
          aria-disabled={blocked() || running() ? "true" : undefined}
          aria-expanded={shareOpen() === p.copy.instance}
          title={blocked() ?? undefined}
          onClick={() => !blocked() && openShare(p.copy)}
        >
          Share
        </button>
      </Show>
    );
  };

  /** A copy's links (chips with Copy Link and Delete Link), its Share form, and why Share is off. */
  const ShareParts = (p: { copy: CopyView }) => {
    const c = () => p.copy;
    const blocked = () => shareBlocked(c(), !!poll.data()?.sensitive);
    const port = () => (endpoint() ? endpointPort(c(), endpoint()) : null);
    const stopped = () => (endpoint() ? endpointNotRunning(c(), endpoint()) : null);
    return (
      <>
        <Show when={shareOffered(c()) && blocked() && (c().share.endpoints.length || blocked() === SHARE_SENSITIVE)}>
          <p class="list-meta">{blocked()}</p>
        </Show>
        <Show when={c().links.length}>
          <ul class="services-links" aria-label={`Links of ${copyName(c())}`}>
            <For each={c().links}>
              {(l) => (
                <li class="services-link">
                  <Chip tone="accent" title={l.expiresAt}>
                    {linkLine(l, Date.now())}
                  </Chip>
                  <Show when={urlOf(l)}>
                    {(url) => (
                      <button type="button" class="button button-sm" onClick={() => copyLink(url())}>
                        Copy Link
                      </button>
                    )}
                  </Show>
                  <button
                    type="button"
                    class="button button-sm button-destructive"
                    aria-disabled={running() ? "true" : undefined}
                    aria-describedby={armed() === `${l.id}:revoke` ? `link-gone-${l.id}` : undefined}
                    onClick={() => void revoke(c(), l)}
                    onBlur={() => arming.disarm(`${l.id}:revoke`)}
                  >
                    {running() === `${l.id}:revoke` ? DELETING : armed() === `${l.id}:revoke` ? DELETE_ASK : DELETE_LINK}
                  </button>
                  <Show when={armed() === `${l.id}:revoke`}>
                    <p class="delete-note" id={`link-gone-${l.id}`}>
                      {COPY_LINK_GONE}
                    </p>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <Show when={shareOpen() === c().instance && shareOffered(c()) && !blocked()}>
          <form class="stack services-share-form" onSubmit={(e) => void share(e, c())}>
            <div class="services-share-fields">
              <div class="field">
                <label class="field-label" for={`share-endpoint-${c().instance}`}>
                  Endpoint
                </label>
                <select id={`share-endpoint-${c().instance}`} class="select input-mono" onChange={(e) => setEndpoint(e.currentTarget.value)}>
                  <For each={c().share.endpoints}>
                    {(ep) => (
                      <option value={ep} selected={endpoint() === ep}>
                        {ep}
                      </option>
                    )}
                  </For>
                </select>
              </div>
              <div class="field">
                <label class="field-label" for={`share-days-${c().instance}`}>
                  Expires
                </label>
                <select id={`share-days-${c().instance}`} class="select" onChange={(e) => setDays(Number(e.currentTarget.value))}>
                  <For each={SHARE_DAY_CHOICES}>
                    {(d) => (
                      <option value={d} selected={days() === d}>
                        {d === 1 ? "In 1 day" : `In ${d} days`}
                      </option>
                    )}
                  </For>
                </select>
              </div>
            </div>
            <p class="field-hint">{previewWarning(port())}</p>
            <Show when={stopped()}>{(why) => <p class="field-error">{why()}</p>}</Show>
            <div class="button-row">
              <button type="submit" class="button button-sm button-primary" aria-disabled={running() || stopped() ? "true" : undefined}>
                {running() === `${c().instance}:share` ? "Sharing…" : "Share Copy"}
              </button>
              <button type="button" class="button button-sm button-ghost" onClick={() => setShareOpen(null)}>
                Cancel
              </button>
            </div>
          </form>
        </Show>
      </>
    );
  };

  /** One copy's row; under Can go, `why` it can go. */
  const Row = (p: { copy: CopyView; why?: string }) => (
    <CopyRow
      copy={p.copy}
      why={p.why}
      archived={props.archived}
      said={said()[p.copy.instance] ?? null}
      verbs={(verb, quiet) => <VerbButton row={p.copy.instance} verb={verb} name={copyName(p.copy)} body={{ instance: p.copy.instance }} asksFirst={ASKS_FIRST.has(verb)} quiet={quiet} />}
      share={<ShareParts copy={p.copy} />}
      shareButton={props.archived ? null : <ShareButton copy={p.copy} />}
      onLogs={() => setLogs({ instance: p.copy.instance, name: copyName(p.copy) })}
    />
  );

  const view = () => poll.data();
  const root = () => view()?.root ?? "";
  const groups = createMemo(() => copyGroups(copies(), root(), props.landed?.() ?? NO_LANDED));
  const [freeing, setFreeing] = createSignal(false);
  const runningCount = () => copies().filter((c) => c.state === "running" || c.state === "degraded").length;

  return (
    <section class="services-tab" aria-labelledby="project-services">
      <div class="services-head">
        <h2 class="services-h2" id="project-services">
          Running copies
        </h2>
        <p class="services-lede">Live copies of the app on this host, 1 per slot.</p>
      </div>
      <div class="card services-summary">
        <Show when={view()} fallback={<p class="orgs-empty">{poll.error() ? `Couldn't read this project's copies. ${poll.error()}` : "Reading this project's copies."}</p>}>
          {(v) => (
            <>
              <Show
                when={v().limit}
                fallback={
                  <p class="orgs-line">
                    {copies().length === 1 ? "1 copy" : `${copies().length} copies`} on this host, {runningCount()} running.
                  </p>
                }
              >
                {(l) => <CopyLimit projectId={props.projectId} limit={l()} archived={props.archived} changed={() => poll.refetch()} />}
              </Show>
              <Show when={props.archived}>
                <p class="orgs-line">{ARCHIVED_COPIES_LINE}</p>
              </Show>
              <Show when={v().error}>{(e) => <p class="field-error">Couldn't read their status. {e()}</p>}</Show>
              <Show when={poll.error()}>{(e) => <p class="field-error">The last read failed; this is what it showed before. {e()}</p>}</Show>
            </>
          )}
        </Show>
        {/* What replaced the Software card: the services' setup in one line, a live run, a proposed run's review, the feed. */}
        <SetupStatus projectId={props.projectId} archived={props.archived} runtime={props.runtime} />
      </div>
      <Show when={view()}>
        <div class="services-groups">
          <div class="services-group">
            <div class="services-gside">
              <h3 class="services-gname">In use</h3>
              <span class="services-gcount">{inUseCount(groups().inUse)}</span>
            </div>
            <div class="card services-glist">
              <Show
                when={groups().inUse.length || (!hasMain() && !props.archived)}
                fallback={<p class="empty services-gempty">{groups().canGo.length ? "No copy is in use. The ones under Can go are landed or left by the merge queue." : "No copies on this host."}</p>}
              >
                <ul class="list services-list">
                  <For each={groups().inUse}>{(c) => <Row copy={c} />}</For>
                </ul>
                <Show when={!hasMain() && !props.archived}>
                  <div class="services-main-start">
                    <p class="orgs-line">The main checkout has no copy here yet.</p>
                    <VerbButton row="main" verb="up" name="main" body={{}} label="Start Main" />
                    <Show when={said().main}>{(s) => <p class="field-error services-said">{s()}</p>}</Show>
                  </div>
                </Show>
              </Show>
            </div>
          </div>
          <div class="services-group">
            <div class="services-gside">
              <h3 class="services-gname">Can go</h3>
              <span class="services-gcount">{canGoCount(groups().canGo.length)}</span>
              <button
                type="button"
                class="button button-sm button-destructive services-free"
                aria-disabled={!groups().canGo.length || running() ? "true" : undefined}
                aria-describedby={groups().canGo.length ? undefined : "services-free-why"}
                aria-haspopup="dialog"
                onClick={() => groups().canGo.length && !running() && setFreeing(true)}
              >
                {groups().canGo.length ? `Free Up Slots · ${groups().canGo.length}` : "Free Up Slots"}
              </button>
              <Show when={!groups().canGo.length}>
                <span class="services-free-why" id="services-free-why">
                  Nothing has landed or been left by the merge queue.
                </span>
              </Show>
            </div>
            <div class="card services-glist">
              <Show
                when={groups().canGo.length}
                fallback={
                  <div class="empty services-gempty">
                    <p class="empty-title">{groups().inUse.length === 1 ? "1 copy in use." : `${groups().inUse.length} copies in use.`} None ready to tear down.</p>
                    <p class="empty-body">Copies show here once their branch lands, or when the merge queue leaves one stopped.</p>
                  </div>
                }
              >
                <ul class="list services-list">
                  <For each={groups().canGo}>{(g) => <Row copy={g.copy} why={goWord(g.why)} />}</For>
                </ul>
              </Show>
            </div>
          </div>
        </div>
      </Show>
      {/* Preview links (§mesh.public/preview-card): this project's apps, on this host. */}
      <PreviewsCard projectId={props.projectId} archived={props.archived} />
      <Show when={(view()?.shared.length ?? 0) > 0 && copies()[0]}>
        {(via) => (
          <section class="card orgs-section services-shared" aria-labelledby="services-shared">
            <h3 class="orgs-h2" id="services-shared">
              Shared services
            </h3>
            <p class="list-meta">One for every copy of the project. Stopping one stops it for all of them.</p>
            <ul class="list services-list">
              <For each={view()!.shared}>
                {(s) => {
                  const row = `shared:${s.name}`;
                  return (
                    <li class="list-row services-row">
                      <div class="list-main services-row-main">
                        <p class="list-title services-row-title">
                          <span class="services-name">{s.name}</span>
                          <span class="services-row-chip">
                            <Chip tone={SERVICE_CHIP[s.state].tone}>{SERVICE_CHIP[s.state].word}</Chip>
                          </span>
                          <span class="services-row-meta">{memoryOf(s.rssBytes ?? null)}</span>
                        </p>
                        <Show when={Object.keys(s.ports).length}>
                          <p class="list-meta services-facts">
                            <Ports service={s} />
                          </p>
                        </Show>
                        <Show when={said()[row]}>{(line) => <p class="field-error services-said">{line()}</p>}</Show>
                      </div>
                      {/* Both always offered: the one the service's state calls for is drawn first and plain. */}
                      <div class="services-actions">
                        <div class="services-actions-group">
                          <Show
                            when={s.state === "ready" || s.state === "starting"}
                            fallback={
                              <>
                                <Show when={!props.archived}>
                                  <VerbButton row={row} verb="up" name={s.name} body={{ instance: via().instance, services: [s.name] }} />
                                </Show>
                                <VerbButton row={row} verb="down" name={s.name} body={{ instance: via().instance, services: [s.name] }} asksFirst quiet />
                              </>
                            }
                          >
                            <VerbButton row={row} verb="down" name={s.name} body={{ instance: via().instance, services: [s.name] }} asksFirst />
                            <Show when={!props.archived}>
                              <VerbButton row={row} verb="up" name={s.name} body={{ instance: via().instance, services: [s.name] }} quiet />
                            </Show>
                          </Show>
                        </div>
                      </div>
                    </li>
                  );
                }}
              </For>
            </ul>
          </section>
        )}
      </Show>
      <RecentFeed runtime={props.runtime} />
      <Show when={logs()} keyed>
        {(l) => <ServiceLogsDrawer projectId={props.projectId} instance={l.instance} name={l.name} onClose={() => setLogs(null)} />}
      </Show>
      <Show when={freeing()}>
        <FreeUpDialog
          projectId={props.projectId}
          copies={groups().canGo}
          onClose={() => setFreeing(false)}
          onDone={() => {
            setFreeing(false);
            poll.refetch();
          }}
        />
      </Show>
    </section>
  );
}

/**
 * One copy's row: its name, state chip, slot, memory and maker on one line, its ports as tags under
 * it, then its actions by weight (Open first and plain while its entry's service is ready, the verbs then
 * all ghost; else the verb its state calls for plain, the quieter rest; the destructive ones apart); at narrow widths the actions wrap
 * under the facts.
 */
function CopyRow(props: { copy: CopyView; why?: string; archived: boolean; said: string | null; verbs(v: RowVerb, quiet: boolean): JSX.Element; share: JSX.Element; shareButton: JSX.Element; onLogs(): void }) {
  const c = () => props.copy;
  const chip = () => copyChip(c().state, isStarting(c().state, c().services), gaveUp(c().services), restarting(c().services));
  const failed = () => failedBlocks(c().services);
  const entry = () => openEntry(c());
  const groups = () => verbGroups(props.archived ? archivedVerbs(rowVerbs(c())) : rowVerbs(c()), !!entry());
  const ported = () => c().services.filter((s) => Object.keys(s.ports).length);
  return (
    <li class="list-row services-row">
      <div class="list-main services-row-main">
        <p class="list-title services-row-title">
          <span class="services-name text-mono" title={c().checkout}>
            {copyName(c())}
          </span>
          <span class="services-row-chip">
            <Chip tone={chip().tone}>{chip().word}</Chip>
          </span>
          <span class="services-row-meta">
            <Show when={props.why}>{(w) => <span class="services-why">{w()}</span>}</Show>
            <span>slot {c().slot}</span>
            {/* Memory only once it was read: a stopped copy has none, and a bare dash says nothing. */}
            <Show when={copyMemory(c().services) !== "—"}>
              <span title="Resident memory of its services now">{copyMemory(c().services)}</span>
            </Show>
            <span title={c().createdBy}>by {createdByWord(c().createdBy)}</span>
          </span>
        </p>
        <Show when={ported().length}>
          <p class="list-meta services-facts">
            <For each={ported()}>{(s) => <Ports service={s} named />}</For>
          </p>
        </Show>
        <Show when={c().state !== "stopped" && c().state !== "absent" && notReadyLine(c().services)}>{(line) => <p class="list-meta">{line()}</p>}</Show>
        {/* What gave up retrying, how many times, its last try and log lines; Start (on the row) runs it again. */}
        <Show when={failed().length}>
          <div class="services-failed">
            <For each={failed()}>
              {(f) => (
                <div class="services-failed-one">
                  <p class="services-failed-head">{f.heading}</p>
                  <p class="list-meta">{f.lastTry}</p>
                  <Show when={f.lines.length}>
                    <pre class="services-failed-lines" aria-label={`Last log lines of ${f.service}`}>{f.lines.join("\n")}</pre>
                  </Show>
                </div>
              )}
            </For>
            <p class="list-meta">{START_AGAIN}</p>
          </div>
        </Show>
        <Show when={c().adopted}>{(unit) => <p class="list-meta">{adoptedLine(unit())}</p>}</Show>
        <Show when={props.said}>{(line) => <p class="field-error services-said">{line()}</p>}</Show>
      </div>
      <div class="services-actions">
        <div class="services-actions-group">
          {/* The app itself, where a person lands: the row's one plain button while its service is ready. */}
          <Show when={entry()}>
            {(e) => (
              <a class="button button-sm" href={entryHref(location.hostname, e())} target="_blank" rel="noopener" title={entryTitle(copyName(c()), e())}>
                Open
                <Icon name="external" small />
              </a>
            )}
          </Show>
          <Show when={groups().primary}>{(verb) => props.verbs(verb(), false)}</Show>
          <For each={groups().quiet}>{(verb) => props.verbs(verb, true)}</For>
          {props.shareButton}
          <button type="button" class="button button-sm button-ghost" onClick={() => props.onLogs()}>
            Logs
          </button>
        </div>
        <Show when={groups().destructive.length}>
          <div class="services-actions-group services-actions-danger">
            <For each={groups().destructive}>{(verb) => props.verbs(verb, false)}</For>
          </div>
        </Show>
      </div>
      {/* Links and the Share form take the row's whole width, under its facts and actions. */}
      <div class="services-row-share">{props.share}</div>
    </li>
  );
}

/**
 * The services' setup in one line (§app.project-runtime/software-card, which it replaced): the registry's standing
 * as a chip, when it was checked, and Set Up with a Chat or Change Setup…, the one way into the project's standing
 * Project verbs chat (the first press starts it, every press after opens it), or in its place the one sentence that
 * says why it can't; above it, while never set up, what running copies are; under it why it failed or is out of
 * date, what still runs undeclared, a live run's progress, and a proposed run's review with Merge Branch.
 */
function SetupStatus(props: { projectId: string; archived: boolean; runtime: Poll<ProjectRuntimeView> }) {
  const poll = props.runtime;
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const run = async () => {
    if (busy()) return;
    setBusy(true);
    setError(null);
    try {
      const out = await runProjectVerbsPlaybook(props.projectId);
      if (out.reopened) announce("Opened the Project verbs chat.");
      else {
        const done = out.worktree ? `The Project verbs playbook started on ${out.worktree.branch}.` : "The Project verbs playbook started.";
        toast(done);
        announce(done);
      }
      // The chat opens at once: you say what to refine by typing in it.
      if (out.path) location.hash = projectSessionHref(props.projectId, out.path);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
      poll.refetch();
    }
  };
  return (
    <div class="services-setup" aria-label="Services setup">
      <Show when={poll.data()} fallback={<Show when={poll.error()} fallback={<Placeholder lines={1} label="Services setup" />}>{(e) => <p class="orgs-empty">Couldn't read the services setup. {e()}</p>}</Show>}>
        {(v) => {
          const st = () => setupStatus(v());
          const strip = () => runStrip(v(), Date.now());
          const unset = () => notSetUpWords(v());
          return (
            <>
              <Show when={unset()}>
                {(w) => (
                  <div class="services-setup-unset">
                    <p class="list-title">{w().title}</p>
                    <p class="orgs-line">{w().body}</p>
                  </div>
                )}
              </Show>
              <div class="services-setup-line">
                <Chip tone={st().tone}>{st().word}</Chip>
                <span class="services-setup-when">
                  <Show when={st().checked}>
                    {(at) => (
                      <>
                        checked <time title={at()}>{relativeTime(at())}</time>
                      </>
                    )}
                  </Show>
                </span>
                {/* While a run is proposed: Merge Branch (§app.project-runtime/merge). */}
                <Show when={proposedRun(v())}>{(r) => <MergeRunButton projectId={props.projectId} run={r()} onDone={(view) => (view ? poll.set(view) : poll.refetch())} />}</Show>
                <Show when={v().can.onboard && !props.archived}>
                  <button type="button" class={`button button-sm${unset() && !proposedRun(v()) ? " button-primary" : ""}`} aria-disabled={busy() ? "true" : undefined} onClick={() => void run()}>
                    <Icon name="chat" small />
                    {busy() ? "Opening…" : playbookLabel(v())}
                  </button>
                </Show>
              </div>
              {/* Never hidden without its sentence: the start's own refusal, read before any press. */}
              <Show when={!v().can.onboard && v().can.onboardWhy}>{(why) => <p class="orgs-line services-setup-why">{why()}</p>}</Show>
              <Show when={st().why}>{(why) => <p class={`orgs-line${v().standing === "failed" ? " project-software-failed" : ""}`}>{why()}</p>}</Show>
              <For each={v().orphans}>
                {(o) => (
                  <p class="orgs-line services-orphan">
                    <Chip tone="warn">Orphan</Chip> <span class="project-software-name">{o.name}</span> still runs in {o.label}, no longer declared.
                  </p>
                )}
              </For>
              {/* A live run as it goes (§app.project-runtime/run-progress): from its session, no tool of its own. */}
              <Show when={strip()}>
                {(s) => (
                  <p class="project-run-strip" aria-label={`${v().playbook!.label} run`}>
                    <Chip tone={STRIP_TONE[s().state]} live={s().state === "Working"}>
                      {s().state}
                    </Chip>
                    <Show when={runWord(v())}>{(w) => <span>{w()}</span>}</Show>
                    <Show when={s().elapsed}>{(e) => <span class="list-meta">{e()}</span>}</Show>
                    <Show when={s().questions ?? s().now}>{(line) => <span class="project-run-now">{line()}</span>}</Show>
                    <Show when={v().playbook?.path}>
                      {(path) => (
                        <a class="project-software-open" href={projectSessionHref(props.projectId, path())}>
                          {s().questions ? "Answer in Its Session" : "Open Session"}
                          <Icon name="chevron-right" small />
                        </a>
                      )}
                    </Show>
                  </p>
                )}
              </Show>
              {/* What a proposed run's branch proposes, read by Sova (§app.project-runtime/run-report). */}
              <Show when={v().playbookState === "proposed" ? v().playbook?.review : undefined}>
                {(r) => (
                  <div class="project-run-review" role="group" aria-label="What the run proposes">
                    <Show when={!reviewDefProblem(r())} fallback={<p class="orgs-line project-software-failed">{reviewDefProblem(r())}</p>}>
                      <ul class="orgs-history-list project-software-list">
                        <For each={r().services}>
                          {(s) => (
                            <li class="orgs-change project-software-row">
                              <span class="orgs-change-main">
                                <span class="project-software-name">{s.name}</span> <span class="list-meta" title={s.isolation?.why}>{serviceFacts(s)}</span>
                                <Show when={portsWord(s)}>{(p) => <span class="list-meta text-mono"> · {p()}</span>}</Show>
                                <Show when={memoryWord(s.memory)}>{(m) => <span class="list-meta"> · {m()}</span>}</Show>
                              </span>
                            </li>
                          )}
                        </For>
                        <For each={r().data}>
                          {(d) => (
                            <li class="orgs-change project-software-row">
                              <span class="orgs-change-main">
                                <span class="project-software-name">{d.name}</span> <span class="list-meta">data · {d.kind}</span>
                              </span>
                              <Show when={d.sensitive}>
                                <Chip tone="warn" title={SENSITIVE_TITLE}>
                                  Sensitive
                                </Chip>
                              </Show>
                            </li>
                          )}
                        </For>
                      </ul>
                      <p class="list-meta">
                        {shareWord(r())} · {openWord(r())}
                      </p>
                    </Show>
                    <p class="list-meta">{reviewProofWord(r())}</p>
                    <Show when={!reviewDefProblem(r())}>
                      <p class="list-meta" classList={{ "text-mono": !!r().test }}>{testsWord(r())}</p>
                      <p class="list-meta">{setupStepsWord(r())}</p>
                    </Show>
                    {/* A deploy-setup run: its recipe as Sova renders it. */}
                    <Show when={r().deploy}>{(d) => <DeployRecipeSteps recipe={d()} />}</Show>
                    {/* A Release playbook maker run: the release settings and the playbook's steps it proposes. */}
                    <Show when={r().release}>{(rel) => <ReleaseSetupSteps setup={rel()} />}</Show>
                    <Show when={v().playbook?.path}>
                      {(path) => (
                        <p class="orgs-line">
                          <a class="project-software-open" href={projectSessionHref(props.projectId, path())}>
                            Read Report
                            <Icon name="chevron-right" small />
                          </a>
                        </p>
                      )}
                    </Show>
                  </div>
                )}
              </Show>
              <Show when={error()}>{(e) => <p class="field-error">{e()}</p>}</Show>
            </>
          );
        }}
      </Show>
    </div>
  );
}

/** The registry's feed (definition, onMerge and deploy notes), newest first, under a closed Recent. */
function RecentFeed(props: { runtime: Poll<ProjectRuntimeView> }) {
  const feed = () => props.runtime.data()?.feed ?? [];
  return (
    <Show when={feed().length}>
      <details class="card services-recent">
        <summary class="services-recent-summary">
          <span class="services-recent-title">Recent</span>
          <span class="list-meta">{feed().length > RECENT_SHOWN ? `latest ${RECENT_SHOWN}` : feed().length === 1 ? "1 entry" : `${feed().length} entries`}</span>
          <Icon name="chevron-down" small />
        </summary>
        <ul class="list services-recent-list" aria-label="Recent setup and deploy notes">
          <For each={feed().slice(0, RECENT_SHOWN)}>
            {(f) => (
              <li class="list-row services-recent-row">
                <span class="services-recent-line">{f.line}</span>
                <time class="list-meta" title={f.at}>
                  {relativeTime(f.at)}
                </time>
              </li>
            )}
          </For>
        </ul>
      </details>
    </Show>
  );
}

/**
 * Free Up Slots, asked first: the copies under Can go with why each can go, what stays (branches, commits,
 * sessions), then Remove {n} Copies, which tears each down in turn as the operator. Focus starts on Cancel.
 * A refusal stops nothing else: the dialog stays open with each copy's reason.
 */
function FreeUpDialog(props: { projectId: string; copies: readonly { copy: CopyView; why: GoReason }[]; onClose(): void; onDone(): void }) {
  // The list as it was when opened: a refresh underneath never changes what Remove removes.
  const list = props.copies.slice();
  const [pending, setPending] = createSignal(false);
  const [failed, setFailed] = createSignal<Record<string, string>>({});
  let cancelButton!: HTMLButtonElement;
  onMount(() => cancelButton.focus());
  const close = () => !pending() && props.onClose();
  const remove = async () => {
    if (pending()) return;
    setPending(true);
    setFailed({});
    const freed: number[] = [];
    const why: Record<string, string> = {};
    for (const { copy } of list) {
      try {
        const r = await runProjectVerb(props.projectId, "teardown", { instance: copy.instance, confirm: true });
        const no = refusalLine(r);
        if (no) why[copy.instance] = no;
        else freed.push(copy.slot);
      } catch (x) {
        why[copy.instance] = `Couldn't reach the engine. ${errText(x)}`;
      }
    }
    setPending(false);
    if (freed.length) {
      const done = freedLine(freed);
      toast(done);
      announce(done);
    }
    if (Object.keys(why).length) {
      setFailed(why);
      announce(`${Object.keys(why).length === 1 ? "1 copy wasn't" : `${Object.keys(why).length} copies weren't`} removed.`);
    } else props.onDone();
  };
  return (
    <>
      <div class="scrim" onClick={close} />
      <div
        class="modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="free-slots-title"
        aria-describedby="free-slots-body"
        ref={(el) => trapFocus(el)}
        onKeyDown={(e) => {
          if (e.key === "Escape") close();
        }}
      >
        <div class="modal-head">
          <h2 class="modal-title" id="free-slots-title">
            {freeTitle(list.length)}
          </h2>
        </div>
        <div class="modal-body" id="free-slots-body">
          <p class="message-text">These copies stop and are removed. Each is landed or left by the merge queue.</p>
          <ul class="services-free-list">
            <For each={list}>
              {(g) => (
                <li>
                  <span class="text-mono">{copyName(g.copy)}</span> · slot {g.copy.slot} · {goWord(g.why)}
                  <Show when={failed()[g.copy.instance]}>{(w) => <p class="field-error">{w()}</p>}</Show>
                </li>
              )}
            </For>
          </ul>
          <p class="message-text">The branches, commits and sessions stay. Removing a copy can't be undone, but you can start a new one.</p>
        </div>
        <div class="modal-foot">
          <span class="modal-spacer" />
          <button ref={cancelButton} type="button" class="button button-ghost" aria-disabled={pending() ? "true" : undefined} onClick={close}>
            {Object.keys(failed()).length ? "Close" : "Cancel"}
          </button>
          <Show when={!Object.keys(failed()).length}>
            <button type="button" class="button button-destructive" aria-disabled={pending() ? "true" : undefined} onClick={() => void remove()}>
              {pending() ? "Removing…" : freeButton(list.length)}
            </button>
          </Show>
        </div>
      </div>
    </>
  );
}
