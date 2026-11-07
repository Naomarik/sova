import { createMemo, createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import type { TimeSpentRecord } from "../../shared/time-spent";
import { formatSpent, type SpentLine, spentView } from "../lib/time-spent-view";
import { keepTimeSpentRead, lastTimeSpentRead, TIME_SPENT_READ_MS } from "../lib/time-spent-section";
import { noteTimeSpentRefused, timeSpentLive, timeSpentReadDone, timeSpentReadStart } from "../lib/time-spent";
import { ApiError, fetchTimeSpent } from "../lib/api";
import { Icon } from "./ui";

/**
 * The Time Spent tab (§app.subagents-pane/time-spent): You and Agent, the word, the rows, Your Messages
 * and Alignments. Mounted only while the tab shows, which is when it ticks; counting itself is the
 * tracker's and goes on without it. Nothing here is a live region: the tick is silent.
 */
export function TimeSpentTab(props: { path: string }) {
  const path = createMemo(() => props.path);
  return (
    <div class="time-spent">
      {/* Keyed: another session's figures never show under this one's, and its clock starts fresh. */}
      <Show when={path()} keyed>
        {(p) => <TimeSpentBody path={p} />}
      </Show>
    </div>
  );
}

/**
 * A list that keeps each entry's elements while its key lasts. Every tick and read draws new objects, and a plain
 * <For> over them would rebuild every row each second: an opened row would close and lose focus.
 */
function ByKey<T>(props: { items: readonly T[]; keyOf: (item: T) => string; children: (item: () => T) => JSX.Element }) {
  const keys = createMemo(() => props.items.map(props.keyOf));
  return (
    <For each={keys()}>
      {(key) => {
        // Keeps the last value for the moment between an entry leaving and its elements going.
        const item = createMemo<T>((last) => props.items.find((i) => props.keyOf(i) === key) ?? last!);
        return props.children(item);
      }}
    </For>
  );
}

const byLineKey = (line: { key: string }) => line.key;

/** A row that opens: its label with the chevron after the word, so it lines up with the rows beside it and what it opens to reads as under it. */
function OpeningRow(props: { rowKey: string; label: string; count?: number | null; seconds: number; children: JSX.Element }) {
  const [open, setOpen] = createSignal(false);
  return (
    <li class="time-spent-opening">
      <button
        type="button"
        class="time-spent-row time-spent-expander"
        aria-expanded={open() ? "true" : "false"}
        data-time-row={props.rowKey}
        data-seconds={props.seconds}
        onClick={() => setOpen(!open())}
      >
        <span class="time-spent-row-label">
          {props.label}
          <Icon name="chevron-right" small class={open() ? "icon-twist time-spent-twist-open" : "icon-twist"} />
        </span>
        <Show when={props.count !== undefined}>
          <Count value={props.count ?? null} noun="message" />
        </Show>
        <span class="text-num">{formatSpent(props.seconds)}</span>
      </button>
      <Show when={open()}>{props.children}</Show>
    </li>
  );
}

/** A row's count, in its own column just before the time; the digit alone on screen, the word for assistive technology. */
function Count(props: { value: number | null; noun: "message" | "action" }) {
  return (
    <span class="time-spent-count text-num" data-time-count={props.value ?? ""}>
      {props.value ?? ""}
      <Show when={props.value !== null}>
        <span class="visually-hidden"> {props.value === 1 ? props.noun : `${props.noun}s`}</span>
      </Show>
    </span>
  );
}

function Parts(props: { parts: SpentLine[] }) {
  return (
    <ul class="time-spent-parts">
      <ByKey items={props.parts} keyOf={byLineKey}>
        {(part) => (
          <li class="time-spent-row time-spent-part" data-time-row={part().key} data-seconds={part().seconds}>
            <span>{part().label}</span>
            <span class="text-num">{formatSpent(part().seconds)}</span>
          </li>
        )}
      </ByKey>
    </ul>
  );
}

/** One placeholder bar over a line of text: the line keeps the height its real text would have. */
function Line(props: { class: string; width: string }) {
  return (
    <p class={`${props.class} text-skeleton`}>
      &nbsp;
      <span class="skeleton" style={{ width: props.width }} />
    </p>
  );
}

function TimeSpentBody(props: { path: string }) {
  const live = timeSpentLive(props.path);
  const kept = lastTimeSpentRead(props.path);
  const [record, setRecord] = createSignal<TimeSpentRecord | null>(kept?.record ?? null);
  const [readAt, setReadAt] = createSignal(kept?.at ?? 0);
  const [now, setNow] = createSignal(Date.now());

  let run = 0;
  const read = async () => {
    const mine = ++run;
    const token = timeSpentReadStart(props.path);
    try {
      const next = await fetchTimeSpent(props.path);
      if (mine !== run) return;
      const at = Date.now();
      setRecord(next);
      setReadAt(at);
      keepTimeSpentRead(props.path, next, at);
      timeSpentReadDone(props.path, token);
    } catch (err) {
      // Only a refusal or a computer too old for the route is Not Recording; anything else is a
      // brief failure, which changes no word, and the next read retries.
      if (mine === run && err instanceof ApiError && [401, 403, 404, 405].includes(err.status)) noteTimeSpentRefused(props.path);
    }
  };
  const visible = () => document.visibilityState === "visible";
  void read();
  const reads = setInterval(() => visible() && void read(), TIME_SPENT_READ_MS);
  const ticks = setInterval(() => visible() && setNow(Date.now()), 1000);
  const onVisible = () => {
    if (visible()) void read();
  };
  document.addEventListener("visibilitychange", onVisible);
  onCleanup(() => {
    run++;
    clearInterval(reads);
    clearInterval(ticks);
    document.removeEventListener("visibilitychange", onVisible);
  });

  const view = createMemo(() => {
    const r = record();
    return r ? spentView(r, live(), (now() - readAt()) / 1000) : null;
  });
  const refused = () => live().word === "Not Recording";

  return (
    <div class="time-spent-body">
      <Show
        when={view()}
        fallback={
          <Show
            when={refused()}
            fallback={
              /* The usual section's own lines (the figures, Reading and two rows), so
                 nothing jumps when the figures land; never a zero. */
              <div class="time-spent-skeleton" aria-hidden="true">
                <div>
                  <Line class="text-caption" width="20%" />
                  <Line class="time-spent-figure" width="45%" />
                </div>
                <div class="time-spent-rows">
                  <Line class="time-spent-row" width="35%" />
                  <Line class="time-spent-row" width="30%" />
                  <Line class="time-spent-row" width="25%" />
                </div>
              </div>
            }
          >
            <p class="time-spent-word text-caption" data-time-word>
              Not Recording
            </p>
          </Show>
        }
      >
        {(v) => (
          <>
            <div class="time-spent-head">
              <dl class="time-spent-figures">
                <div>
                  <dt class="text-caption">You</dt>
                  <dd class="time-spent-figure text-num" data-time-you data-seconds={v().you}>
                    {formatSpent(v().you)}
                  </dd>
                </div>
                <div>
                  <dt class="text-caption">Agent</dt>
                  <dd class="time-spent-figure text-num" data-time-agent data-seconds={v().agent}>
                    {formatSpent(v().agent)}
                  </dd>
                </div>
              </dl>
              <span class="time-spent-word text-caption" data-time-word>
                {v().word}
              </span>
            </div>

            <Show when={v().reading || v().rows.length > 0}>
              {/* No visible heading: the rows are obvious under You. The name stays for assistive technology. */}
              <ul class="time-spent-rows" aria-label="Your Time">
                <Show when={v().reading}>
                  {(reading) => (
                    <OpeningRow rowKey="reading" label="Reading" seconds={reading().seconds}>
                      <Parts parts={reading().parts} />
                    </OpeningRow>
                  )}
                </Show>
                <ByKey items={v().rows} keyOf={byLineKey}>
                  {(row) => (
                    <Show
                      when={row().parts?.length ? row().parts : null}
                      fallback={
                        <li class="time-spent-row" data-time-row={row().key} data-seconds={row().seconds}>
                          <span>{row().label}</span>
                          <span class="text-num">{formatSpent(row().seconds)}</span>
                        </li>
                      }
                    >
                      {(parts) => (
                        <OpeningRow rowKey={row().key} label={row().label} seconds={row().seconds}>
                          <Parts parts={parts()} />
                        </OpeningRow>
                      )}
                    </Show>
                  )}
                </ByKey>
              </ul>
            </Show>

            <Show when={v().messages}>
              {(lines) => (
                <div class="stack-2">
                  <h4 class="time-spent-sub text-caption">Your Messages</h4>
                  <ul class="time-spent-rows time-spent-message-rows">
                    <ByKey items={lines()} keyOf={byLineKey}>
                      {(line) => (
                        <Show
                          when={line().messages}
                          fallback={
                            <li class="time-spent-row" data-time-row={line().key} data-seconds={line().seconds}>
                              <span>{line().label}</span>
                              <Count value={line().count} noun="action" />
                              <span class="text-num">{formatSpent(line().seconds)}</span>
                            </li>
                          }
                        >
                          {(messages) => (
                            <OpeningRow rowKey={line().key} label={line().label} count={line().count} seconds={line().seconds}>
                              <ul class="time-spent-parts time-spent-messages">
                                <ByKey items={messages()} keyOf={(m) => m.id}>
                                  {(m) => (
                                    <li class="time-spent-message" data-time-message={m().id} data-seconds={m().seconds}>
                                      <p class="time-spent-excerpt text-caption">{m().excerpt}</p>
                                      <span class="time-spent-message-time text-caption text-num">{formatSpent(m().seconds)}</span>
                                      <Show when={m().labelledBy}>
                                        <p class="time-spent-labelled-by text-caption text-muted" data-time-labelled-by>
                                          Labelled by {m().labelledBy}
                                        </p>
                                      </Show>
                                    </li>
                                  )}
                                </ByKey>
                              </ul>
                            </OpeningRow>
                          )}
                        </Show>
                      )}
                    </ByKey>
                  </ul>
                </div>
              )}
            </Show>

            <Show when={v().alignments.length > 0}>
              <div class="stack-2">
                <h4 class="time-spent-sub text-caption">Alignments</h4>
                <ul class="time-spent-docs">
                  <ByKey items={v().alignments} keyOf={(d) => d.docId}>
                    {(doc) => (
                      <li data-time-doc={doc().docId}>
                        <p class="time-spent-doc-title text-caption">{doc().title}</p>
                        <p class="text-caption text-muted text-num">{doc().words}</p>
                      </li>
                    )}
                  </ByKey>
                </ul>
              </div>
            </Show>

          </>
        )}
      </Show>
    </div>
  );
}
