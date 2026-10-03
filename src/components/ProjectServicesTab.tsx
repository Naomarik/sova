import { createSignal, For, type JSX, Show } from "solid-js";
import type { VerbResult } from "../../shared/project-contract";
import type { CopyView, ServiceRowView } from "../../shared/services-view";
import { getProjectServices, runProjectVerb } from "../lib/api";
import { createPoll } from "../lib/poll";
import {
  ASKS_FIRST,
  confirmLabel,
  COPY_CHIP,
  copyMemory,
  copyName,
  createdByWord,
  doneLine,
  httpHref,
  memoryOf,
  notReadyLine,
  refusalLine,
  type RowVerb,
  SERVICE_CHIP,
  VERB_LABEL,
  VERB_RUNNING,
} from "../lib/services-view";
import { announce, toast } from "../lib/ui-state";
import { ServiceLogsDrawer } from "./ServiceLogsDrawer";
import { Chip } from "./ui";

const POLL_MS = 5_000;
const errText = (x: unknown) => (x instanceof Error ? x.message : String(x));
const ROW_VERBS: RowVerb[] = ["up", "down", "apply", "reset", "teardown"];

/** A service's ports, each with HTTP readiness a link on the host this page was opened from. */
function Ports(props: { service: ServiceRowView }) {
  const entries = () => Object.entries(props.service.ports);
  return (
    <For each={entries()}>
      {([name, port]) => (
        <span class="text-mono services-port">
          <Show when={props.service.http?.port === port} fallback={`${name} ${port}`}>
            <a href={httpHref(location.hostname, props.service.http!)} target="_blank" rel="noopener" title={`Open ${props.service.name} on port ${port}`}>
              {name} {port}
            </a>
          </Show>
        </span>
      )}
    </For>
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

  const VerbButton = (p: { row: string; verb: RowVerb; name: string; body: Record<string, unknown>; asksFirst?: boolean; label?: string }) => {
    const key = () => `${p.row}:${p.verb}`;
    const destructive = () => p.verb === "teardown" || p.verb === "reset";
    return (
      <button
        type="button"
        class="button button-sm"
        classList={{ "button-destructive": destructive() }}
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
                      verbs={(verb) => <VerbButton row={c.instance} verb={verb} name={copyName(c)} body={{ instance: c.instance }} asksFirst={ASKS_FIRST.has(verb)} />}
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
                                <Chip tone={SERVICE_CHIP[s.state].tone}>{SERVICE_CHIP[s.state].word}</Chip>
                              </p>
                              <p class="list-meta services-facts">
                                <Ports service={s} />
                                <span>{memoryOf(s.rssBytes ?? null)}</span>
                              </p>
                              <Show when={said()[row]}>{(line) => <p class="field-error services-said">{line()}</p>}</Show>
                            </div>
                            <div class="button-row services-actions">
                              <VerbButton row={row} verb="up" name={s.name} body={{ instance: via().instance, services: [s.name] }} />
                              <VerbButton row={row} verb="down" name={s.name} body={{ instance: via().instance, services: [s.name] }} asksFirst />
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

/** One copy's row: its facts, then its actions; at narrow widths the actions wrap under the facts. */
function CopyRow(props: { copy: CopyView; said: string | null; verbs(v: RowVerb): JSX.Element; onLogs(): void }) {
  const c = () => props.copy;
  const chip = () => COPY_CHIP[c().state];
  return (
    <li class="list-row services-row">
      <div class="list-main services-row-main">
        <p class="list-title services-row-title">
          <span class="services-name text-mono" title={c().checkout}>
            {copyName(c())}
          </span>
          <span class="list-meta">slot {c().slot}</span>
          <Chip tone={chip().tone}>{chip().word}</Chip>
        </p>
        <p class="list-meta services-facts">
          <For each={c().services}>
            {(s) => (
              <Show when={Object.keys(s.ports).length}>
                <span class="services-service">
                  {s.name} <Ports service={s} />
                </span>
              </Show>
            )}
          </For>
          <span title="Resident memory of its services now">{copyMemory(c().services)}</span>
          <span title={c().createdBy}>by {createdByWord(c().createdBy)}</span>
        </p>
        <Show when={c().state !== "stopped" && c().state !== "absent" && notReadyLine(c().services)}>{(line) => <p class="list-meta">{line()}</p>}</Show>
        <Show when={props.said}>{(line) => <p class="field-error services-said">{line()}</p>}</Show>
      </div>
      <div class="button-row services-actions">
        <For each={ROW_VERBS}>{(verb) => props.verbs(verb)}</For>
        <button type="button" class="button button-sm" onClick={() => props.onLogs()}>
          Logs
        </button>
      </div>
    </li>
  );
}
