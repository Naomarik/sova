import { createEffect, createSignal, For, on, Show } from "solid-js";
import type { ArchiveCopies, ArchiveCopy } from "../../shared/projects";
import { ApiError, getRunningCopies, runProjectVerb } from "../lib/api";
import { ADOPTED_ARCHIVE_LINE, afterStops, archiveUnavailable, copiesLead, copyKey, copyStateWord, runsLine, stopLabel, stoppableCopies } from "../lib/archive-copies";
import { createPoll, type Poll } from "../lib/poll";
import { refusalLine } from "../lib/services-view";
import { announce } from "../lib/ui-state";
import { Banner, Chip } from "./ui";

/** While the ask is open, what runs is read this often: a copy stopped elsewhere leaves the list. */
const ASK_POLL_MS = 2_000;
const errText = (err: unknown) => (err instanceof ApiError || err instanceof Error ? err.message : String(err));

/** A project's running copies, read while a surface shows them (null interval: once, then on refetch). */
export const createRunningCopies = (projectId: string, ms: number | null): Poll<ArchiveCopies> =>
  createPoll(
    () =>
      // An older server (or peer) has no such read: nothing listed, and its archive route still decides.
      getRunningCopies(projectId).catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 404) return { copies: [] };
        throw err;
      }),
    ms,
  );

/** The copies an archive refusal carries (409 `copies`), when it carries them. */
export function refusedCopies(err: unknown): ArchiveCopy[] | null {
  const body = err instanceof ApiError ? (err.body as { copies?: unknown } | undefined) : undefined;
  return Array.isArray(body?.copies) ? (body.copies as ArchiveCopy[]) : null;
}

/**
 * The Archive Project ask (§app.organizations/archive): the question, then whatever of the project
 * runs or waits to restart, each with what it runs, and Stop Running Copies. Archive Project stays
 * unavailable, with its reason, until nothing Sova can stop is listed; an adopted main is listed as
 * running outside Sova, with no Stop, and doesn't block. Each stop keeps the copy's data (`down`),
 * and the list is read again after each; a copy that didn't stop stays with its sentence.
 */
export function ProjectArchiveAsk(props: {
  projectId: string;
  name: string;
  archiving: boolean;
  error: string | null;
  /** The copies the last refusal named, adopted at once (a stale list must not wait for the poll). */
  refused: ArchiveCopy[] | null;
  onArchive(): void;
  onCancel(): void;
}) {
  const running = createRunningCopies(props.projectId, ASK_POLL_MS);
  // A refusal's list is the newest word on what runs: shown at once, the poll goes on from it.
  createEffect(on(() => props.refused, (copies) => copies && running.set({ copies })));
  const listed = (): ArchiveCopy[] | undefined => running.data()?.copies;
  const [progress, setProgress] = createSignal<{ done: number; of: number } | null>(null);
  const [failed, setFailed] = createSignal<Record<string, string>>({});
  const failures = () => afterStops(listed() ?? [], failed());
  // A failed read keeps Archive unavailable: what runs is unknown, not none.
  const unavailable = () => (running.error() && !listed() ? "Couldn't read what runs" : archiveUnavailable(listed()));
  const reasonId = `archive-reason-${props.projectId}`;

  const stopAll = async () => {
    const list = stoppableCopies(listed() ?? []);
    if (!list.length || progress()) return;
    setFailed({});
    let stopped = 0;
    for (const [i, c] of list.entries()) {
      setProgress({ done: i, of: list.length });
      let why: string | null;
      try {
        why = refusalLine(await runProjectVerb(props.projectId, "down", c.down!));
      } catch (x) {
        why = `Couldn't reach the engine. ${errText(x)}`;
      }
      if (why) setFailed((f) => ({ ...f, [copyKey(c)]: why! }));
      else stopped++;
      // The list follows each stop.
      try {
        running.set(await getRunningCopies(props.projectId));
      } catch {
        running.refetch();
      }
    }
    setProgress(null);
    const left = list.length - stopped;
    announce(left ? `Stopped ${stopped} of ${list.length}. ${left === 1 ? "1 didn't stop" : `${left} didn't stop`}; its reason is on its row.` : `Stopped ${stopped === 1 ? "1 copy" : `${stopped} copies`}.`);
  };

  return (
    <div class="project-archive-confirm">
      <Banner
        tone="warn"
        title={`${props.name} leaves the Projects list and its overseer stops looking. Nothing is deleted; Unarchive brings it back.`}
        action={
          <div class="button-row">
            <button
              type="button"
              class="button button-sm button-destructive"
              aria-disabled={props.archiving || unavailable() || progress() ? "true" : undefined}
              aria-describedby={unavailable() ? reasonId : undefined}
              title={unavailable() ?? undefined}
              onClick={() => !unavailable() && !progress() && props.onArchive()}
            >
              Archive Project
            </button>
            <button type="button" class="button button-sm button-ghost" onClick={() => props.onCancel()}>
              Cancel
            </button>
          </div>
        }
      />
      <Show when={unavailable()}>
        {(why) => (
          <span class="visually-hidden" id={reasonId}>
            {why()}
          </span>
        )}
      </Show>
      <Show when={listed()?.length}>
        <section class="project-archive-copies" aria-label={`What of ${props.name} runs now`}>
          <Show when={copiesLead(listed()!)}>{(lead) => <p class="orgs-line">{lead()}</p>}</Show>
          <ul class="list">
            <For each={listed()}>
              {(c) => (
                <li class="list-row project-archive-copy">
                  <div class="list-main">
                    <p class="list-title project-archive-copy-title">
                      <span class="text-mono" title={c.checkout ?? undefined}>
                        {c.name}
                      </span>
                      <Chip tone={copyStateWord(c).tone}>{copyStateWord(c).word}</Chip>
                    </p>
                    <p class="list-meta text-mono">{runsLine(c)}</p>
                    <Show when={c.adopted}>
                      <p class="list-meta">{ADOPTED_ARCHIVE_LINE}</p>
                    </Show>
                    <Show when={!c.adopted && !c.down && c.why}>{(why) => <p class="list-meta">{why()}</p>}</Show>
                    <Show when={failures()[copyKey(c)]}>{(why) => <p class="field-error">{why()}</p>}</Show>
                  </div>
                </li>
              )}
            </For>
          </ul>
          <Show when={stoppableCopies(listed()!).length}>
            <div class="button-row">
              <button type="button" class="button button-sm" aria-disabled={progress() ? "true" : undefined} onClick={() => void stopAll()}>
                {stopLabel(progress())}
              </button>
            </div>
          </Show>
        </section>
      </Show>
      <Show when={!listed() && running.error()}>{(e) => <p class="field-error">Couldn't read what runs. {e()}</p>}</Show>
      <Show when={props.error}>{(e) => <p class="field-error">{e()}</p>}</Show>
    </div>
  );
}
