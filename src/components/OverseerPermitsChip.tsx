import { createSignal, For, onCleanup, Show } from "solid-js";
import { actsText, livePermits, type Permit, permitsChipText } from "../../shared/overseer-grants";
import type { ScheduleFire, ScheduleInfo } from "../../shared/protocol";
import { agoTime, stampTime } from "../lib/format";
import { overseerHistoryHref } from "../lib/overseer";
import { canApprove, canRevoke, runsAsText, scheduleStateText } from "../lib/schedules";
import { ScheduleStateChip } from "./ScheduleCard";
import { Icon } from "./ui";

/** The gap the panel keeps from every viewport edge, and the one it keeps from its trigger. */
const EDGE_GAP = 8;
const TRIGGER_GAP = 4;

/** "1 approval · 2 schedules": the permits' own words, then every schedule Sova knows of. */
export function permitsAndSchedulesText(permits: readonly Permit[], schedules: readonly ScheduleInfo[]): string {
  const parts = [permitsChipText(permits)].filter(Boolean);
  if (schedules.length) parts.push(`${schedules.length} schedule${schedules.length === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

/** What the state chip doesn't already say: the next fire, or why it is paused or not valid. */
const scheduleDetail = (s: ScheduleInfo): string => (s.state === "active" ? (s.next ? scheduleStateText(s) : "") : (s.reason ?? ""));

const FIRE_WORDS: Record<ScheduleFire["kind"], string> = { new: "Started a session", wake: "Woke its session", reset: "Continued after a limit reset" };

/** "Until 6:00 PM" / "Until revoked". */
export const permitExpiry = (p: Permit): string => (p.kind === "grant" && p.until ? `Until ${stampTime(p.until)}` : "Until revoked");

/**
 * The Overseer composer's approvals chip (§app.overseer/approvals): "2 approvals · 1 rule" in the
 * run-status row while any is live. It opens a panel listing each live approval for later and
 * standing rule: what it allows, the card it came from, when it ends, its uses (each a link to the
 * act in the thread) and Revoke. The panel is the shared `.model-menu.action-menu` popover, placed
 * above or below the trigger, whichever fits (a bottom sheet on a phone, like every such menu).
 */
export function OverseerPermitsChip(props: {
  permits: Permit[];
  /** Every playbook schedule Sova knows of (§chat.schedules/where-shown). */
  schedules?: ScheduleInfo[];
  onRevoke(id: string): Promise<string | null>;
  onApproveSchedule?(s: ScheduleInfo): Promise<string | null>;
  onRevokeSchedule?(id: string): Promise<string | null>;
  onJumpCard(card: string): void;
  onJumpUse(toolCallId: string): void;
}) {
  let trigger!: HTMLButtonElement;
  let menu!: HTMLDivElement;
  const [open, setOpen] = createSignal(false);
  const [busy, setBusy] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const rows = () => [...livePermits(props.permits)].reverse();

  const place = () => {
    if (!menu.isConnected || !menu.matches(":popover-open")) return;
    const r = trigger.getBoundingClientRect();
    const box = menu.getBoundingClientRect();
    const above = r.top - TRIGGER_GAP - box.height;
    const top = above >= EDGE_GAP ? above : Math.min(r.bottom + TRIGGER_GAP, innerHeight - EDGE_GAP - box.height);
    const left = Math.min(Math.max(r.right - box.width, EDGE_GAP), Math.max(EDGE_GAP, innerWidth - EDGE_GAP - box.width));
    menu.style.setProperty("--menu-top", `${Math.round(Math.max(top, EDGE_GAP))}px`);
    menu.style.setProperty("--menu-left", `${Math.round(left)}px`);
  };
  addEventListener("resize", place);
  onCleanup(() => removeEventListener("resize", place));

  const schedules = () => props.schedules ?? [];
  const chipText = () => permitsAndSchedulesText(props.permits, schedules());
  const revoke = async (id: string, fn: (id: string) => Promise<string | null> = props.onRevoke) => {
    setBusy(id);
    setError(null);
    const failed = await fn(id);
    setBusy(null);
    if (failed) setError(failed);
    queueMicrotask(place);
  };
  const jump = (fn: () => void) => {
    menu.hidePopover();
    fn();
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        class="run-status-link run-status-align run-status-permits"
        aria-haspopup="dialog"
        aria-expanded={open() ? "true" : "false"}
        aria-label={`${chipText()}: what runs without you`}
        title="What the Overseer and your schedules may do without you"
        onClick={() => {
          if (open()) return menu.hidePopover();
          setError(null);
          menu.showPopover();
          place();
        }}
      >
        <Icon name="shield" small />
        <span class="text-num">{chipText()}</span>
        <Icon name="chevron-down" small />
      </button>
      <div
        ref={menu}
        class="model-menu action-menu permits-panel"
        popover="auto"
        role="dialog"
        aria-label="Approvals and rules"
        onToggle={(e) => setOpen((e as ToggleEvent).newState === "open")}
      >
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
                        <a href={`#/sid/${encodeURIComponent(s.id)}`} onClick={() => menu.hidePopover()}>
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
                    <button type="button" class="permit-link text-mono" onClick={() => jump(() => props.onJumpCard(p.card))}>
                      {p.card} {p.option}
                    </button>
                  }
                >
                  {(from) => (
                    <>
                      <a class="permit-link text-mono" href={overseerHistoryHref(from())} onClick={() => menu.hidePopover()}>
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
                        <button type="button" class="permit-link" onClick={() => jump(() => props.onJumpUse(u.toolCallId))}>
                          <span class="text-mono">{u.tool}</span> · {agoTime(u.at)}
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
              <div class="permit-actions">
                <button type="button" class="button button-sm button-destructive" disabled={busy() === p.id} onClick={() => void revoke(p.id)}>
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
                              <a class="permit-link" href={`#/sid/${encodeURIComponent(id())}`} onClick={() => menu.hidePopover()}>
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
                    <Show when={canApprove(sch) && props.onApproveSchedule}>
                      <button type="button" class="button button-sm" disabled={busy() === sch.id} onClick={() => void revoke(sch.id, () => props.onApproveSchedule!(sch))}>
                        Approve Schedule
                      </button>
                    </Show>
                    <Show when={canRevoke(sch) && props.onRevokeSchedule}>
                      <button type="button" class="button button-sm button-destructive" disabled={busy() === sch.id} onClick={() => void revoke(sch.id, (id) => props.onRevokeSchedule!(id))}>
                        Revoke Schedule
                      </button>
                    </Show>
                  </div>
                </Show>
              </section>
            )}
          </For>
        </Show>
        <Show when={error()}>{(e) => <p class="permits-error" role="alert">{e()}</p>}</Show>
      </div>
    </>
  );
}
