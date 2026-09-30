import { createSignal, For, onCleanup, Show } from "solid-js";
import { actsText, livePermits, type Permit, permitsChipText } from "../../shared/overseer-grants";
import { agoTime, stampTime } from "../lib/format";
import { overseerHistoryHref } from "../lib/overseer";
import { Icon } from "./ui";

/** The gap the panel keeps from every viewport edge, and the one it keeps from its trigger. */
const EDGE_GAP = 8;
const TRIGGER_GAP = 4;

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
  onRevoke(id: string): Promise<string | null>;
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

  const revoke = async (id: string) => {
    setBusy(id);
    setError(null);
    const failed = await props.onRevoke(id);
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
        aria-label={`${permitsChipText(props.permits)}: what the Overseer may do without you`}
        title="What the Overseer may do without you"
        onClick={() => {
          if (open()) return menu.hidePopover();
          setError(null);
          menu.showPopover();
          place();
        }}
      >
        <Icon name="shield" small />
        <span class="text-num">{permitsChipText(props.permits)}</span>
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
        <p class="permits-lede">The Overseer may do these without you. Revoking one applies before its next run.</p>
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
        <Show when={error()}>{(e) => <p class="permits-error" role="alert">{e()}</p>}</Show>
      </div>
    </>
  );
}
