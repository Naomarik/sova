import { createSignal, For, onCleanup, Show } from "solid-js";
import { restartSova } from "../lib/api";
import { relativeTime } from "../lib/format";
import type { UpdatesRunning } from "../../shared/protocol";
import { healthStartedAt, restartBlockView, restartConfirmText, restartedLine, runsLabel, serviceCheckCommand, waitForRestart, type RestartPhase } from "../lib/restart";
import { refreshUpdates, updatesState } from "../lib/updates";
import { Banner } from "./ui";

/**
 * Settings → General's **Server · this machine**: when Sova started and what it runs, and Restart
 * Sova with its one confirm. After Restart Now the block waits for Sova to answer with another start
 * (GET /api/health every second), says when it did, and after a minute names the service to check
 * from a terminal while it keeps asking. A copy no service runs shows no button and says why; while
 * an upgrade runs the button waits. It reads the Updates state the section below loads.
 */

/** "Sova is already restarting." → "Sova is already restarting" (the sentence goes on). */
const clause = (s: string) => s.trim().replace(/[.!]+$/, "");

export function ServerSettingsSection() {
  const [phase, setPhase] = createSignal<RestartPhase>("idle");
  const [late, setLate] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let gone = false;
  onCleanup(() => (gone = true));

  const running = () => updatesState()?.running ?? null;
  const upgrading = () => updatesState()?.job?.state === "running";

  const restart = async () => {
    setPhase("sending");
    setError(null);
    setLate(false);
    // The start to wait past, read from health itself just before asking: the wait compares health with health.
    const from = (await healthStartedAt()) ?? running()?.startedAt ?? null;
    if (!from) {
      setError("Couldn't restart Sova: it didn't say when it started, so we couldn't tell when it's back. Nothing was restarted.");
      setPhase("idle");
      return;
    }
    try {
      await restartSova();
    } catch (err) {
      setError(`Couldn't restart Sova: ${clause(err instanceof Error ? err.message : String(err))}. Nothing was restarted.`);
      setPhase("idle");
      return;
    }
    setPhase("waiting");
    const at = await waitForRestart({
      before: from,
      health: () => healthStartedAt(),
      wait: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
      onLate: () => setLate(true),
      stopped: () => gone,
    });
    if (!at) return;
    await refreshUpdates();
    setLate(false);
    setPhase("done");
  };

  const view = (r: UpdatesRunning) => restartBlockView(r, upgrading(), phase());

  return (
    <section class="settings-updates settings-server" aria-labelledby="settings-server-title">
      <h3 class="settings-type-title" id="settings-server-title">
        Server · this machine
      </h3>
      <Show when={running()}>
        {(r) => (
          <>
            <Show when={r().startedAt}>
              <div class="settings-updates-running">
                <span>Started {relativeTime(r().startedAt!)}</span>
                <Show when={runsLabel(r().branch, r().startedHead ?? r().head)}>
                  {(label) => <code class="settings-updates-sha">{label()}</code>}
                </Show>
              </div>
            </Show>

            <Show when={view(r()).hint && !view(r()).button}>
              <p class="field-hint">{view(r()).hint}</p>
            </Show>
            <Show when={r().restartUnit}>
              {(unit) => (
                <>
                  <Show
                    when={phase() === "confirm"}
                    fallback={
                      <div class="button-row">
                        <button type="button" class="button" disabled={view(r()).button!.disabled} onClick={() => (setError(null), setPhase("confirm"))}>
                          {view(r()).button!.label}
                        </button>
                      </div>
                    }
                  >
                    <div class="settings-updates-confirm" role="group" aria-label="Confirm the restart">
                      <For each={restartConfirmText(r())}>{(line) => <p>{line}</p>}</For>
                      <div class="button-row">
                        <button type="button" class="button button-primary" onClick={() => void restart()}>
                          Restart Now
                        </button>
                        <button type="button" class="button button-ghost" onClick={() => setPhase("idle")}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  </Show>
                  <Show when={view(r()).button && view(r()).hint}>
                    <p class="field-hint">{view(r()).hint}</p>
                  </Show>
                  <div class="settings-server-status" role="status" aria-live="polite">
                    <Show when={phase() === "waiting"}>
                      <p>Sova is restarting. Waiting for it to answer…</p>
                    </Show>
                    <Show when={phase() === "done"}>
                      <p>{restartedLine(r())}</p>
                    </Show>
                  </div>
                  <Show when={phase() === "waiting" && late()}>
                    <Banner
                      tone="warn"
                      title="Sova hasn't come back after a minute."
                      body={
                        <>
                          Check its service from a terminal: <code>{serviceCheckCommand(unit())}</code>. We keep asking, and say so here when it answers.
                        </>
                      }
                    />
                  </Show>
                </>
              )}
            </Show>
            <Show when={error()}>
              <Banner tone="error" title={error()!} />
            </Show>
          </>
        )}
      </Show>
    </section>
  );
}
