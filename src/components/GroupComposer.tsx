import { createMemo, createSignal, For, Show } from "solid-js";
import type { BatchRefusal, SessionSummary } from "../../shared/protocol";
import { promptSessionGroup } from "../lib/api";
import { composerPlaceholder, refusalBody, refusalSentence, targetsLine, targetsOf } from "../lib/group-prompt";
import { announce, toast } from "../lib/ui-state";
import { Banner, Icon } from "./ui";

/** Below this the placeholder drops its key hint: the keys aren't there to press (§9). */
const FOLDED = "(max-width: 767px)";

/**
 * The workspace's one composer, writing to every member at once
 * (spec/14-workspaces.md "The group composer"). One request, never N sockets racing: the server
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
  /** The pane name of a member, for every sentence that has to say which one. */
  nameOf(id: string): string;
  /** A send landed: the list's `busy` is stale until it is re-read. */
  onSent(): void;
  /** Focused or holding text — what collapses the pane composers under it. */
  onActive(active: boolean): void;
}) {
  let input!: HTMLTextAreaElement;
  const [text, setText] = createSignal("");
  const [sending, setSending] = createSignal(false);
  /** The last 409: nothing was sent, and every blocked member is named. */
  const [refused, setRefused] = createSignal<BatchRefusal[] | null>(null);
  /** A member lost between the pre-check and the send. Not a refusal — the others did get it. */
  const [partial, setPartial] = createSignal<{ failed: BatchRefusal[]; sent: number } | null>(null);
  const [folded, setFolded] = createSignal(window.matchMedia(FOLDED).matches);
  window.matchMedia(FOLDED).addEventListener("change", (e) => setFolded(e.matches));

  const targets = createMemo(() => targetsOf(props.members));
  /** Nobody at all: the only state where Send is off. A stale snapshot is the server's to correct. */
  const noone = () => targets().available.length === 0;

  /** Both banners go when the text changes: they describe a send of the text that was there. */
  const edit = (v: string) => {
    setText(v);
    setRefused(null);
    setPartial(null);
  };

  /** The name a refusal is about, from the id the server joined it by. */
  const nameOfRefusal = (r: BatchRefusal) => props.nameOf(r.id);

  const send = async (subset?: string[]) => {
    const body = text().trim();
    if (!body || sending() || noone()) return;
    setSending(true);
    const out = await promptSessionGroup(props.groupId, body, subset);
    setSending(false);
    if (out.ok) {
      const n = out.result.sent.length;
      setRefused(null);
      // A member that broke between the check and being queued: the others are answering, and
      // nothing is rolled back — say exactly that rather than pretending the batch failed.
      setPartial(out.result.failed.length > 0 ? { failed: out.result.failed, sent: n } : null);
      if (out.result.failed.length === 0) {
        edit("");
        input.value = "";
      }
      const said = `Sent to ${n} ${n === 1 ? "member" : "members"}.`;
      announce(said);
      props.onSent();
      props.onActive(false);
      return;
    }
    if (out.refused) {
      // The draft is kept: nothing was sent, and retyping it would be the app's mistake to charge
      // the user for.
      setPartial(null);
      setRefused(out.refused);
      announce(`Nothing was sent. ${out.refused.length} ${out.refused.length === 1 ? "member" : "members"} can't take a message right now.`);
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
              body={refusalBody(list().map((r) => refusalSentence(r, nameOfRefusal(r))), props.members.length, rest().length)}
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
              title={`Sent to ${p().sent} of ${props.members.length} members.`}
              body={`${p()
                .failed.map((r) => nameOfRefusal(r))
                .join(", ")} was taken by another program between the check and the send, so it didn't get this message. The ${p().sent} that did are answering now.`}
              action={
                <button type="button" class="button button-sm" onClick={() => void send(p().failed.map((r) => r.id))}>
                  Send to {nameOfRefusal(p().failed[0]!)}
                </button>
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
            placeholder={composerPlaceholder(props.members.length, folded())}
            aria-describedby="group-composer-reason"
            onInput={(e) => {
              edit(e.currentTarget.value);
              props.onActive(!!e.currentTarget.value);
            }}
            onFocus={() => props.onActive(true)}
            onBlur={() => props.onActive(!!text())}
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
                {sending() ? "Sending…" : props.members.length === 1 ? "Send" : "Send to All"}
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
