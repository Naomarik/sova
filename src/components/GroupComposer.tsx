import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import type { BatchRefusal, SessionSummary } from "../../shared/protocol";
import { promptSessionGroup } from "../lib/api";
import { composerPlaceholder, partialAfterRetry, partialBody, partialRetries, refusalBody, refusalSentence, targetsLine, targetsOf, withGone, type Targets } from "../lib/group-prompt";
import { announce, toast } from "../lib/ui-state";
import { Banner, Icon } from "./ui";

/** Below this the placeholder drops its key hint: the keys aren't there to press. */
const FOLDED = "(max-width: 767px)";

/**
 * The workspace's one composer, writing to every member at once.
 * One request, never N sockets racing: the server
 * checks every member before it prompts any, so a refusal is complete and names each blocked one.
 *
 * What it deliberately does NOT carry: images and slash commands. An image belongs to a
 * conversation and a slash command is a per-runtime thing, half of them local — both stay in the
 * pane composers, where their target is one session. The route has no attachments field at all,
 * which is what "the plus trigger is absent rather than disabled" means on the wire.
 */
export function GroupComposer(props: {
  groupId: string;
  /** The group's members in pane order; the foot counts from these. */
  members: SessionSummary[];
  /** The group's file-gone members, as session ids: no session row
      exists for them, so they reach neither the panes nor `targetsOf` — but the server's pre-check
      refuses a send on the ASSIGNMENT, and the foot has to be the count that comes back. They
      ride under `missing`, and they count in the total, which is the group's size. */
  gone?: string[];
  /** The pane name of a member, for every sentence that has to say which one. */
  nameOf(id: string): string;
  /** Re-read the session list: after a send its `busy` is stale, and after a 400 the membership
      this composer is counting from is the thing that was wrong. */
  onRefresh(): void;
  /** Focused or holding text — what collapses the pane composers under it. */
  onActive(active: boolean): void;
  /** The ids a send REACHED (accepted, not answered), for the workspace head's completion roll-up:
   * the roll-up is anchored to a send rather than to idle-vs-busy, so it starts at the
   *  moment the server accepted. `kind` is how the workspace merges it: a box send (or "Send to
   *  the Rest", which follows a refusal — nothing was sent, so there is no anchor to keep)
   *  REPLACES the watched set; a partial banner's retry UNIONS it, so the straggler is watched
   *  alongside the members already answering and the roll-up can reach "5 of 5 replied". */
  onSent?(sentIds: string[], kind: "send" | "retry"): void;
}) {
  let input!: HTMLTextAreaElement;
  const [text, setText] = createSignal("");
  const [sending, setSending] = createSignal(false);
  /** The last 409: nothing was sent, and every blocked member is named. */
  const [refused, setRefused] = createSignal<BatchRefusal[] | null>(null);
  /**
   * A member lost between the pre-check and the send. Not a refusal — the others did get it, and
   * this is a REPORT of something that happened rather than an offer waiting on the box. It
   * therefore carries the text that was actually sent: the retry must hand the straggler THAT
   * message, not whatever the box reads by then.
   */
  const [partial, setPartial] = createSignal<{ failed: BatchRefusal[]; sent: number; text: string } | null>(null);
  /** Whether the caret is in this box. Half of "in use"; the other half is holding text. */
  const [focused, setFocused] = createSignal(false);
  const [folded, setFolded] = createSignal(window.matchMedia(FOLDED).matches);
  window.matchMedia(FOLDED).addEventListener("change", (e) => setFolded(e.matches));

  /**
   * "In use" is focused OR holding text, derived in ONE place. It used to be pushed
   * from three — focus, blur, and the send — and they disagreed: a send cleared the box while the
   * caret was still in it, so the panes expanded under a composer the user was still typing in and
   * collapsed again on the next keystroke. A rule with three call sites is three chances to state
   * it differently.
   */
  createEffect(() => props.onActive(focused() || !!text()));

  const targets = createMemo<Targets>(() => withGone(targetsOf(props.members), props.gone ?? []));
  /** The group's size, not the list's: a gone member is a member until it is removed. */
  const totalMembers = () => props.members.length + (props.gone?.length ?? 0);
  /** Nobody at all: the only state where Send is off. A stale snapshot is the server's to correct. */
  const noone = () => targets().available.length === 0;

  /**
   * Editing dismisses the REFUSAL — it is an offer to send what is in the box, and the box just
   * changed. The partial banner stays: it reports that k members have a message and one doesn't,
   * which is still true however the box reads, and dropping it on a keystroke would take the only
   * record of the straggler (and its retry) with it.
   */
  const edit = (v: string) => {
    setText(v);
    setRefused(null);
  };

  /** The name a refusal is about, from the id the server joined it by. */
  const nameOfRefusal = (r: BatchRefusal) => props.nameOf(r.id);

  /**
   * `body` is set only by the partial banner's retry, which re-sends the string captured AT SEND
   * TIME. The box stays visible and editable while that banner is up, so reading it here would
   * hand the straggler a different message under a label promising the same one — the exact thing
   * a shared composer exists to prevent. An edited box is a new message to everyone, through Send.
   */
  const send = async (subset?: string[], body?: string) => {
    const fromBox = body === undefined;
    const sent = (body ?? text()).trim();
    if (!sent || sending() || noone()) return;
    setSending(true);
    const out = await promptSessionGroup(props.groupId, sent, subset);
    setSending(false);
    if (out.ok) {
      const n = out.result.sent.length;
      setRefused(null);
      // A banner retry reaches SOME of the members that missed out, and the report is the only
      // record of who never got the message: it survives with exactly the still-missing members
      // (partialAfterRetry). A box send — with or without a subset chosen at the refusal banner —
      // reports its own outcome wholesale; it is a new message, superseding the old report.
      const was = partial();
      const next =
        body !== undefined && was
          ? partialAfterRetry(was, out.result.sent)
          : out.result.failed.length > 0
            ? { failed: out.result.failed, sent: n, text: sent }
            : null;
      setPartial(next);
      // The roll-up's anchor: this is the set the workspace counts "replied" against, from the
      // moment the server accepted — accepted, not answered (the route never waits for turns).
      props.onSent?.(out.result.sent, body === undefined ? "send" : "retry");
      // Only the box's own send clears the box. A retry may run while the user is typing the next
      // message, and wiping that would be this composer destroying work to report success.
      if (fromBox && !next) {
        edit("");
        input.value = "";
      }
      const said = `Sent to ${n} ${n === 1 ? "member" : "members"}.`;
      announce(said);
      props.onRefresh();
      return;
    }
    if (out.refused) {
      // The draft is kept: nothing was sent, and retyping it would be the app's mistake to charge
      // the user for. A refused RETRY keeps the partial report — it is still true — while a
      // refused box send replaces the report with the refusal's own offer.
      if (body === undefined) setPartial(null);
      setRefused(out.refused);
      // No announce() here: the banner is a role=status, so it speaks for itself. Saying it twice
      // in one region reads as two events, and the second one is a summary of the first.
      return;
    }
    // 400 means the server disagreed about WHO is in the group — a member left between the list
    // this composer counted and the press. The server's sentence names a session id, which is not
    // a thing the user can read, so say what happened and re-read the list that was wrong.
    if (out.status === 400) {
      props.onRefresh();
      toast("The group changed while that was on screen. Check who's in it, then send again.");
      return;
    }
    toast(`Couldn't send to this group. ${out.error}`);
  };

  /** "Send to the Rest": the user's explicit subset, in one press — never inferred server-side. */
  const rest = createMemo(() => {
    const blocked = new Set((refused() ?? []).map((r) => r.id));
    return props.members.map((m) => m.id).filter((id) => !blocked.has(id));
  });

  return (
    <footer class="composer group-composer" id="group-composer">
      <form
        class="composer-inner"
        aria-label="Message every member"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <Show when={refused()}>
          {(list) => (
            <Banner
              tone="warn"
              title="Nothing was sent."
              body={refusalBody(list().map((r) => refusalSentence(r, nameOfRefusal(r))), totalMembers(), rest().length)}
              action={
                <>
                  <Show when={rest().length > 0}>
                    <button type="button" class="button button-sm" onClick={() => void send(rest())}>
                      Send to the Rest ({rest().length})
                    </button>
                  </Show>
                  <button type="button" class="button button-sm button-ghost" onClick={() => setRefused(null)}>
                    Cancel
                  </button>
                </>
              }
            />
          )}
        </Show>
        <Show when={partial()}>
          {(p) => (
            <Banner
              tone="warn"
              title={`Sent to ${p().sent} of ${totalMembers()} members.`}
              body={partialBody(
                p().failed.map((r) => props.nameOf(r.id)),
                p().sent,
              )}
              action={
                /* One button per member that missed out, each re-sending to exactly the member it
                   names (partialRetries): a button's label and the subset it requests are the same
                   fact, so the two cannot drift apart the way `Send to {first}` over every failed
                   id did — the many-failed case and the common one take the same shape. */
                <span class="cluster">
                  <For each={partialRetries(p().failed, props.nameOf)}>
                    {(retry) => (
                      <button type="button" class="button button-sm" onClick={() => void send([retry.id], p().text)}>
                        {retry.label}
                      </button>
                    )}
                  </For>
                </span>
              }
            />
          )}
        </Show>

        <div class="composer-row">
          <label class="visually-hidden" for="group-composer-input">
            Message every member
          </label>
          <textarea
            ref={input}
            class="input textarea composer-input"
            id="group-composer-input"
            rows={1}
            placeholder={composerPlaceholder(totalMembers(), folded())}
            aria-describedby="group-composer-reason"
            onInput={(e) => edit(e.currentTarget.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div class="composer-actions">
            {/* The workspace's one primary: the accent says "this goes to all of them", which is
                the choice worth marking. A pane's own Send is secondary while this is on screen. */}
            <button type="submit" class="button button-primary" aria-disabled={noone() || sending() ? "true" : undefined}>
              <Icon name="arrow-right" small />
              <span class="button-label">
                {sending() ? "Sending…" : totalMembers() === 1 ? "Send" : "Send to All"}
              </span>
            </button>
          </div>
        </div>

        <div class="composer-foot">
          <span class="group-composer-targets">{targetsLine(targets())}</span>
          <span class="composer-reason" id="group-composer-reason">
            <Show when={noone()}>
              <Icon name="attention" small />
              No member can take a message right now.
            </Show>
          </span>
        </div>
      </form>
    </footer>
  );
}
