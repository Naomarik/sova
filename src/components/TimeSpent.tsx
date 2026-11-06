import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { TimeSpentRecord } from "../../shared/time-spent";
import { formatSpent, spentView } from "../lib/time-spent-view";
import { keepTimeSpentRead, lastTimeSpentRead, setTimeSpentOpen, TIME_SPENT_READ_MS, timeSpentOpen } from "../lib/time-spent-section";
import { noteTimeSpentRefused, timeSpentLive, timeSpentReadDone, timeSpentReadStart } from "../lib/time-spent";
import { ApiError, fetchTimeSpent } from "../lib/api";
import { Icon } from "./ui";

/**
 * Time Spent on the Session tab (§app.subagents-pane/time-spent): You and Agent, the word, Your Time,
 * Alignments and the two notes. Mounted only while that tab shows, which is when it ticks; counting
 * itself is the tracker's and goes on without it. Nothing here is a live region: the tick is silent.
 */
export function TimeSpentSection(props: { path: string; labelId: string }) {
  const path = createMemo(() => props.path);
  const open = timeSpentOpen;
  const bodyId = () => `${props.labelId}-body`;
  return (
    <section class="stack-2 time-spent" aria-labelledby={props.labelId}>
      <h3 class="time-spent-heading">
        <button
          type="button"
          class="time-spent-toggle"
          aria-expanded={open() ? "true" : "false"}
          aria-controls={open() ? bodyId() : undefined}
          onClick={() => setTimeSpentOpen(!open())}
        >
          <Icon name="chevron-right" small class={open() ? "icon-twist time-spent-twist-open" : "icon-twist"} />
          <span class="text-eyebrow" id={props.labelId}>
            Time Spent
          </span>
        </button>
      </h3>
      <Show when={open()}>
        {/* Keyed: another session's figures never show under this one's, and its clock starts fresh. */}
        <Show when={path()} keyed>
          {(p) => <TimeSpentBody path={p} id={bodyId()} />}
        </Show>
      </Show>
    </section>
  );
}

function TimeSpentBody(props: { path: string; id: string }) {
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
  const [readingOpen, setReadingOpen] = createSignal(false);

  return (
    <div class="time-spent-body stack-2" id={props.id}>
      <Show
        when={view()}
        fallback={
          <Show
            when={refused()}
            fallback={
              /* About the section's usual height, never a zero, so Repository doesn't jump. */
              <div class="time-spent-skeleton" aria-hidden="true">
                <For each={["35%", "60%", "50%", "45%", "85%"]}>
                  {(width) => (
                    <p class="text-caption text-skeleton">
                      &nbsp;
                      <span class="skeleton" style={{ width }} />
                    </p>
                  )}
                </For>
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
                  <dt class="text-caption text-muted">You</dt>
                  <dd class="time-spent-figure text-num" data-time-you data-seconds={v().you}>
                    {formatSpent(v().you)}
                  </dd>
                </div>
                <div>
                  <dt class="text-caption text-muted">Agent</dt>
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
              <h4 class="time-spent-sub text-caption">Your Time</h4>
              <ul class="time-spent-rows">
                <Show when={v().reading}>
                  {(reading) => (
                    <>
                      <li>
                        <button
                          type="button"
                          class="time-spent-row time-spent-expander"
                          aria-expanded={readingOpen() ? "true" : "false"}
                          data-time-row="reading"
                          data-seconds={reading().seconds}
                          onClick={() => setReadingOpen(!readingOpen())}
                        >
                          {/* The chevron after the word, so Reading lines up with the rows beside it and its parts read as under it. */}
                          <span class="time-spent-row-label">
                            Reading
                            <Icon name="chevron-right" small class={readingOpen() ? "icon-twist time-spent-twist-open" : "icon-twist"} />
                          </span>
                          <span class="text-num">{formatSpent(reading().seconds)}</span>
                        </button>
                      </li>
                      <Show when={readingOpen()}>
                        <For each={reading().parts}>
                          {(part) => (
                            <li class="time-spent-row time-spent-part" data-time-row={part.key} data-seconds={part.seconds}>
                              <span>{part.label}</span>
                              <span class="text-num">{formatSpent(part.seconds)}</span>
                            </li>
                          )}
                        </For>
                      </Show>
                    </>
                  )}
                </Show>
                <For each={v().rows}>
                  {(row) => (
                    <li class="time-spent-row" data-time-row={row.key} data-seconds={row.seconds}>
                      <span>{row.label}</span>
                      <span class="text-num">{formatSpent(row.seconds)}</span>
                    </li>
                  )}
                </For>
              </ul>
            </Show>

            <Show when={v().alignments.length > 0}>
              <h4 class="time-spent-sub text-caption">Alignments</h4>
              <ul class="time-spent-docs">
                <For each={v().alignments}>
                  {(doc) => (
                    <li data-time-doc={doc.docId}>
                      <p class="time-spent-doc-title text-caption">{doc.title}</p>
                      <p class="text-caption text-muted text-num">{doc.words}</p>
                    </li>
                  )}
                </For>
              </ul>
            </Show>

            <p class="usage-note">An estimate. Reading makes no events, so this goes by what's on screen and your last input.</p>
            <Show when={v().older}>
              <p class="usage-note">Your time before Time Spent arrived wasn't recorded.</p>
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}
