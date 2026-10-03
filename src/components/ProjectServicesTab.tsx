import { createSignal, For, type JSX, Show } from "solid-js";
import type { LinkView, VerbResult } from "../../shared/project-contract";
import { type CopyView, isStarting, type ServiceRowView } from "../../shared/services-view";
import { getProjectServices, runProjectVerb } from "../lib/api";
import { createPoll } from "../lib/poll";
import {
  adoptedLine,
  ASKS_FIRST,
  confirmLabel,
  copyChip,
  copyMemory,
  copyName,
  createdByWord,
  DESTRUCTIVE,
  doneLine,
  httpHref,
  memoryOf,
  notReadyLine,
  portLabel,
  refusalLine,
  rowVerbs,
  type RowVerb,
  SERVICE_CHIP,
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
import { announce, copyText, toast } from "../lib/ui-state";
import { ServiceLogsDrawer } from "./ServiceLogsDrawer";
import { Chip } from "./ui";

const POLL_MS = 5_000;
const errText = (x: unknown) => (x instanceof Error ? x.message : String(x));

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
 * A project's Services tab (§app.project-services/services-ui): one row per copy on this host, the
 * main checkout's first, each with its ports, memory, state and who made it, and Start, Stop, Apply,
 * Reset, Logs and Teardown run as the operator; the shared services in their own block. Reset and
 * Teardown (and Stop of a shared service) ask first; a refusal reads as a sentence under its row.
 */
export function ProjectServicesTab(props: { projectId: string; archived: boolean }) {
  const poll = createPoll(() => getProjectServices(props.projectId), POLL_MS);
  /** `<instance or service>:<verb>` of the verb in flight. */
  const [running, setRunning] = createSignal<string | null>(null);
  /** The button whose next click confirms. */
  const [armed, setArmed] = createSignal<string | null>(null);
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
  /** Turn Off one link: a second click confirms. */
  const revoke = async (c: CopyView, l: LinkView) => {
    const key = `${l.id}:revoke`;
    if (running()) return;
    if (armed() !== key) return setArmed(key);
    setArmed(null);
    setRunning(key);
    try {
      const r = await runProjectVerb(props.projectId, "revoke", { link: l.id });
      const why = refusalLine(r);
      if (why) say(c.instance, why);
      else toast(`The ${l.endpoint} link of ${copyName(c)} is off.`);
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

  /** A copy's links (chips with Copy Link and Turn Off), its Share form, and why Share is off. */
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
                    onClick={() => void revoke(c(), l)}
                    onBlur={() => armed() === `${l.id}:revoke` && setArmed(null)}
                  >
                    {running() === `${l.id}:revoke` ? "Turning off…" : armed() === `${l.id}:revoke` ? "Turn Off Link?" : "Turn Off"}
                  </button>
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

  return (
    <section class="card orgs-section services-tab" aria-labelledby="project-services">
      <h2 class="orgs-h2" id="project-services">
        Services
      </h2>
      <Show when={poll.data()} fallback={<p class="orgs-empty">{poll.error() ? `Couldn't read this project's copies. ${poll.error()}` : "Reading this project's copies."}</p>}>
        {(v) => (
          <>
            <p class="orgs-line">
              {copies().length === 1 ? "1 copy" : `${copies().length} copies`} on this host, {copies().filter((c) => c.state === "running" || c.state === "degraded").length} running.
            </p>
            <Show when={v().error}>{(e) => <p class="field-error">Couldn't read their status. {e()}</p>}</Show>
            <Show when={poll.error()}>{(e) => <p class="field-error">The last read failed; this is what it showed before. {e()}</p>}</Show>
            <Show when={copies().length}>
              <ul class="list services-list">
                <For each={copies()}>
                  {(c) => (
                    <CopyRow
                      copy={c}
                      said={said()[c.instance] ?? null}
                      verbs={(verb, quiet) => <VerbButton row={c.instance} verb={verb} name={copyName(c)} body={{ instance: c.instance }} asksFirst={ASKS_FIRST.has(verb)} quiet={quiet} />}
                      share={<ShareParts copy={c} />}
                      shareButton={<ShareButton copy={c} />}
                      onLogs={() => setLogs({ instance: c.instance, name: copyName(c) })}
                    />
                  )}
                </For>
              </ul>
            </Show>
            <Show when={!hasMain() && !props.archived}>
              <div class="services-main-start">
                <p class="orgs-line">The main checkout has no copy here yet.</p>
                <VerbButton row="main" verb="up" name="main" body={{}} label="Start Main" />
                <Show when={said().main}>{(s) => <p class="field-error services-said">{s()}</p>}</Show>
              </div>
            </Show>
            <Show when={v().shared.length > 0 && copies()[0]}>
              {(via) => (
                <div class="services-shared">
                  <h3 class="list-group-label">Shared services</h3>
                  <p class="list-meta">One for every copy of the project. Stopping one stops it for all of them.</p>
                  <ul class="list services-list">
                    <For each={v().shared}>
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
                                      <VerbButton row={row} verb="up" name={s.name} body={{ instance: via().instance, services: [s.name] }} />
                                      <VerbButton row={row} verb="down" name={s.name} body={{ instance: via().instance, services: [s.name] }} asksFirst quiet />
                                    </>
                                  }
                                >
                                  <VerbButton row={row} verb="down" name={s.name} body={{ instance: via().instance, services: [s.name] }} asksFirst />
                                  <VerbButton row={row} verb="up" name={s.name} body={{ instance: via().instance, services: [s.name] }} quiet />
                                </Show>
                              </div>
                            </div>
                          </li>
                        );
                      }}
                    </For>
                  </ul>
                </div>
              )}
            </Show>
          </>
        )}
      </Show>
      <Show when={logs()} keyed>
        {(l) => <ServiceLogsDrawer projectId={props.projectId} instance={l.instance} name={l.name} onClose={() => setLogs(null)} />}
      </Show>
    </section>
  );
}

/**
 * One copy's row: its name, state chip, slot, memory and maker on one line, its ports as tags under
 * it, then its actions by weight (the one its state calls for, the quieter rest, the destructive ones
 * apart); at narrow widths the actions wrap under the facts.
 */
function CopyRow(props: { copy: CopyView; said: string | null; verbs(v: RowVerb, quiet: boolean): JSX.Element; share: JSX.Element; shareButton: JSX.Element; onLogs(): void }) {
  const c = () => props.copy;
  const chip = () => copyChip(c().state, isStarting(c().state, c().services));
  const groups = () => verbGroups(rowVerbs(c()));
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
            <span>slot {c().slot}</span>
            <span title="Resident memory of its services now">{copyMemory(c().services)}</span>
            <span title={c().createdBy}>by {createdByWord(c().createdBy)}</span>
          </span>
        </p>
        <Show when={ported().length}>
          <p class="list-meta services-facts">
            <For each={ported()}>{(s) => <Ports service={s} named />}</For>
          </p>
        </Show>
        <Show when={c().state !== "stopped" && c().state !== "absent" && notReadyLine(c().services)}>{(line) => <p class="list-meta">{line()}</p>}</Show>
        <Show when={c().adopted}>{(unit) => <p class="list-meta">{adoptedLine(unit())}</p>}</Show>
        <Show when={props.said}>{(line) => <p class="field-error services-said">{line()}</p>}</Show>
      </div>
      <div class="services-actions">
        <div class="services-actions-group">
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
