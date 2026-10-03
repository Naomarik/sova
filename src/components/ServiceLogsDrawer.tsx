import { createSignal, For, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import type { LogLine } from "../../shared/project-contract";
import { SERVICES_LOG_LINES } from "../../shared/services-view";
import { runProjectVerb } from "../lib/api";
import { refusalLine } from "../lib/services-view";
import { trapFocus } from "./ui";

/** Re-read while open: a copy's logs move as it runs. */
const LOGS_POLL_MS = 3_000;
const errText = (x: unknown) => (x instanceof Error ? x.message : String(x));
/** The 24-hour time of a journal or log-file stamp, else the stamp as it came. */
const timeOf = (t: string): string => {
  const d = new Date(t);
  return t && !Number.isNaN(d.getTime()) ? d.toTimeString().slice(0, 8) : t;
};

/**
 * A copy's logs (§app.project-services/services-ui): its last 200 lines, oldest first, re-read every
 * 3 seconds while open and kept at the bottom unless the operator scrolled up. A modal, a sheet at
 * folded width; Close or Escape returns focus to the button that opened it.
 */
export function ServiceLogsDrawer(props: { projectId: string; instance: string; name: string; onClose(): void }) {
  const [lines, setLines] = createSignal<LogLine[] | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  let box: HTMLPreElement | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  onCleanup(() => {
    closed = true;
    clearTimeout(timer);
  });

  const read = async () => {
    const atBottom = !box || box.scrollHeight - box.scrollTop - box.clientHeight < 24;
    try {
      const r = await runProjectVerb(props.projectId, "logs", { instance: props.instance, lines: SERVICES_LOG_LINES });
      if (closed) return;
      const why = refusalLine(r);
      if (why) setError(why);
      else {
        setError(null);
        setLines(r.lines ?? []);
      }
    } catch (x) {
      if (!closed) setError(errText(x));
    }
    if (closed) return;
    if (atBottom && box) queueMicrotask(() => box && (box.scrollTop = box.scrollHeight));
    timer = setTimeout(() => void read(), LOGS_POLL_MS);
  };
  void read();

  return (
    <Portal>
      <div class="scrim" onClick={() => props.onClose()} />
      <div
        class="modal modal-wide services-logs"
        role="dialog"
        aria-modal="true"
        aria-labelledby="services-logs-title"
        ref={(el) => trapFocus(el)}
        onKeyDown={(e) => {
          if (e.key === "Escape") props.onClose();
        }}
      >
        <div class="sheet-grip" aria-hidden="true" />
        <div class="modal-head">
          <h2 class="modal-title" id="services-logs-title">
            Logs · {props.name}
          </h2>
        </div>
        <div class="modal-body">
          <p class="list-meta">The last {SERVICES_LOG_LINES} lines, oldest first. Read again every 3 seconds.</p>
          <Show when={error()}>{(e) => <p class="field-error">{e()}</p>}</Show>
          <Show when={lines()} fallback={<p class="orgs-empty">Reading its logs.</p>}>
            {(ls) => (
              <Show when={ls().length} fallback={<p class="orgs-empty">Nothing logged yet.</p>}>
                <pre class="services-logs-lines" tabindex="0" aria-label={`The last lines of ${props.name}`} ref={(el) => (box = el)}>
                  <For each={ls()}>
                    {(l) => (
                      <span class="services-log-line">
                        <span class="services-log-meta">
                          {timeOf(l.t)} {l.service}
                        </span>{" "}
                        {l.text}
                        {"\n"}
                      </span>
                    )}
                  </For>
                </pre>
              </Show>
            )}
          </Show>
        </div>
        <div class="modal-foot">
          <button type="button" class="button" onClick={() => props.onClose()}>
            Close
          </button>
        </div>
      </div>
    </Portal>
  );
}
