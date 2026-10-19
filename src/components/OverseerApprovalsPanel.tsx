import { createSignal, For, Show } from "solid-js";
import { actsText, livePermits, type Permit } from "../../shared/overseer-grants";
import type { OverseerAutonomy, ScheduleFire, ScheduleInfo } from "../../shared/protocol";
import { agoTime, stampTime } from "../lib/format";
import { overseerHistoryHref } from "../lib/overseer";
import { canApprove, canRevoke, runsAsText, scheduleStateText } from "../lib/schedules";
import { ScheduleStateChip } from "./ScheduleCard";

/**
 * What the Overseer's chat publishes to its page head (§app.overseer/approvals): the one autonomy
 * reading it keeps (read on open, at every turn's end and every 15 s) and the acts on it. The head
 * never reads the autonomy itself, so its dot, its note and this panel all follow that one poll.
 */
export interface OverseerApprovals {
  autonomy(): OverseerAutonomy | undefined;
  revokePermit(id: string): Promise<string | null>;
  approveSchedule(s: ScheduleInfo): Promise<string | null>;
  revokeSchedule(id: string): Promise<string | null>;
  /** Scroll the conversation to a card, or to an act's row in the thread. */
  jumpCard(card: string): void;
  jumpUse(toolCallId: string): void;
}

/** What the state chip doesn't already say: the next fire, or why it is paused or not valid. */
const scheduleDetail = (s: ScheduleInfo): string => (s.state === "active" ? (s.next ? scheduleStateText(s) : "") : (s.reason ?? ""));

const FIRE_WORDS: Record<ScheduleFire["kind"], string> = { new: "Started a session", wake: "Woke its session", reset: "Continued after a limit reset" };

/** "Until 6:00 PM" / "Until revoked". */
export const permitExpiry = (p: Permit): string => (p.kind === "grant" && p.until ? `Until ${stampTime(p.until)}` : "Until revoked");

/**
 * The Approvals & Schedules screen's body (§app.overseer/approvals): each live approval for later
 * and standing rule (what it allows, the card it came from, when it ends, its uses as links to the
 * acts in the thread, Revoke), then every playbook schedule (§chat.schedules/where-shown) with
 * Approve or Revoke. The ⋯ menu's screen and the wide head's Schedules ▾ both draw it; `close`
 * shuts whichever menu holds it, before any link or jump goes anywhere.
 */
export function OverseerApprovalsBody(props: { approvals: OverseerApprovals; close(): void }) {
  const [busy, setBusy] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const autonomy = () => props.approvals.autonomy();
  const rows = () => [...livePermits(autonomy()?.permits ?? [])].reverse();
  const schedules = () => autonomy()?.schedules ?? [];

  const act = async (id: string, fn: () => Promise<string | null>) => {
    setBusy(id);
    setError(null);
    const failed = await fn();
    setBusy(null);
    if (failed) setError(failed);
  };
  const jump = (fn: () => void) => {
    props.close();
    fn();
  };

  return (
    <div class="permits-body" role="group" aria-label="Approvals and schedules">
      <Show when={autonomy()} fallback={<p class="permits-lede">Reading approvals and schedules.</p>}>
        <Show when={!rows().length && !schedules().length}>
          <p class="permits-lede">Nothing runs without you: no approvals, rules or schedules.</p>
        </Show>
        <Show when={rows().length}>
          <p class="permits-lede">The Overseer may do these without you. Revoking one applies before its next run.</p>
        </Show>
        <For each={rows()}>
          {(p) => (
            <section class="permit-row" aria-label={`${p.id}: ${p.kind === "grant" ? "approval for later" : "standing rule"}`}>
              <div class="permit-head">
                <span class="text-mono permit-id">{p.id}</span>
                <span class="permit-kind">{p.kind === "grant" ? "Approved for later" : "Standing rule"}</span>
                <span class="permit-expiry">{permitExpiry(p)}</span>
              </div>
              <Show when={p.text}>{(t) => <p class="permit-text">{t()}</p>}</Show>
              <p class="permit-allows">
                {p.kind === "grant" ? "Any act" : actsText(p.acts).replace(/^./, (c) => c.toUpperCase())} on{" "}
                <Show when={p.sessions !== "any"} fallback="any session">
                  <For each={p.sessions as { id: string; title: string }[]}>
                    {(s, i) => (
                      <>
                        {i() > 0 ? ", " : ""}
                        <a href={`#/sid/${encodeURIComponent(s.id)}`} onClick={() => props.close()}>
                          {s.title}
                        </a>
                      </>
                    )}
                  </For>
                </Show>
              </p>
              <p class="permit-meta">
                From{" "}
                {/* A rule carried over /clear: its card is in the earlier conversation, not this thread. */}
                <Show
                  when={p.from}
                  fallback={
                    <button type="button" class="permit-link text-mono" onClick={() => jump(() => props.approvals.jumpCard(p.card))}>
                      {p.card} {p.option}
                    </button>
                  }
                >
                  {(from) => (
                    <>
                      <a class="permit-link text-mono" href={overseerHistoryHref(from())} onClick={() => props.close()}>
                        {p.card} {p.option}
                      </a>{" "}
                      in an earlier conversation
                    </>
                  )}
                </Show>
                {" · "}
                {p.uses.length ? `Used ${p.uses.length} ${p.uses.length === 1 ? "time" : "times"}, last ${agoTime(p.uses.at(-1)!.at)}` : "Not used yet"}
              </p>
              <Show when={p.uses.length}>
                <ul class="permit-uses">
                  <For each={[...p.uses].reverse().slice(0, 5)}>
                    {(u) => (
                      <li>
                        <button type="button" class="permit-link" onClick={() => jump(() => props.approvals.jumpUse(u.toolCallId))}>
                          <span class="text-mono">{u.tool}</span> · {agoTime(u.at)}
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
              <div class="permit-actions">
                <button type="button" class="button button-sm button-destructive" disabled={busy() === p.id} onClick={() => void act(p.id, () => props.approvals.revokePermit(p.id))}>
                  {p.kind === "grant" ? "Revoke Approval" : "Revoke Rule"}
                </button>
              </div>
            </section>
          )}
        </For>
        <Show when={schedules().length}>
          <p class="permits-lede">Playbooks that run on a schedule, once you approve them. Revoking one stops its next fire.</p>
          <For each={schedules()}>
            {(sch) => (
              <section class="permit-row" aria-label={`${sch.id}: schedule of ${sch.title}`}>
                <div class="permit-head">
                  <span class="text-mono permit-id">{sch.id}</span>
                  <span class="permit-kind">
                    {sch.title} · {sch.projectName}
                  </span>
                  <ScheduleStateChip schedule={sch} />
                </div>
                <p class="permit-text">{sch.text ?? `when: ${sch.when}`}</p>
                <p class="permit-allows">
                  {runsAsText(sch)}
                  {scheduleDetail(sch) ? ` · ${scheduleDetail(sch)}` : ""}
                </p>
                <p class="permit-meta">{sch.fires.length ? `Last fired ${agoTime(sch.fires.at(-1)!.at)}` : "Not fired yet"}</p>
                <Show when={sch.fires.length}>
                  <ul class="permit-uses">
                    <For each={[...sch.fires].reverse()}>
                      {(f) => (
                        <li>
                          <Show when={f.sessionId} fallback={FIRE_WORDS[f.kind]}>
                            {(id) => (
                              <a class="permit-link" href={`#/sid/${encodeURIComponent(id())}`} onClick={() => props.close()}>
                                {FIRE_WORDS[f.kind]}
                              </a>
                            )}
                          </Show>{" "}
                          · <span class="text-mono">{f.trigger}</span> · {agoTime(f.at)}
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
                <Show when={canApprove(sch) || canRevoke(sch)}>
                  <div class="permit-actions">
                    <Show when={canApprove(sch)}>
                      <button type="button" class="button button-sm" disabled={busy() === sch.id} onClick={() => void act(sch.id, () => props.approvals.approveSchedule(sch))}>
                        Approve Schedule
                      </button>
                    </Show>
                    <Show when={canRevoke(sch)}>
                      <button type="button" class="button button-sm button-destructive" disabled={busy() === sch.id} onClick={() => void act(sch.id, () => props.approvals.revokeSchedule(sch.id))}>
                        Revoke Schedule
                      </button>
                    </Show>
                  </div>
                </Show>
              </section>
            )}
          </For>
        </Show>
      </Show>
      <Show when={error()}>{(e) => <p class="permits-error" role="alert">{e()}</p>}</Show>
    </div>
  );
}
