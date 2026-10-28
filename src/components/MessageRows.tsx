import { For, Show } from "solid-js";
import type { TmpAttachment } from "../../shared/protocol";
import { stripSessionHeader } from "../../shared/profiles";
import type { ReplyTiming } from "../../shared/usage/perf";
import type { LiveUserState } from "../lib/live";
import { agoTime, stampTime } from "../lib/format";
import { useMinuteNow } from "../lib/minute-clock";
import { ImageStrip } from "./ImageStrip";
import { Markdown } from "./Markdown";
import { PathAttachment } from "./PathAttachment";
import { ReplyTimingHead } from "./ReplyTiming";
import { Icon } from "./ui";
/**
 * The message rows of a transcript (a user's turn, a reply's text, its thinking), drawn the same by
 * the settled list (as Sova's own kinds on the card toolkit, components/BuiltinKinds.tsx) and by the
 * live streaming entries in Thread.tsx.
 */

/** "1:43 PM · 5m ago": the clock in mono, then its age, kept current by the one minute clock
    every head shares. The age drops once it would only repeat the date (past 7 days). */
export function Stamp(props: { iso?: string }) {
  const now = useMinuteNow();
  return (
    <Show when={props.iso}>
      {(iso) => (
        <span class="message-stamp" title={iso()}>
          <span class="message-time">{stampTime(iso(), now())}</span>
          <Show when={agoTime(iso(), now())}>{(ago) => <span class="message-ago"> · {ago()}</span>}</Show>
        </span>
      )}
    </Show>
  );
}

/** The head label for a message that hasn't been delivered yet. "Sending…" is only true while
    nothing has acknowledged it; once the server says it holds the message, the truth is "Queued"
    — it may sit there for minutes, until the agent next polls its queue. */
const PENDING_LABEL: Partial<Record<LiveUserState, string>> = { sending: "Sending…", queued: "Queued" };

/** A message Sova queued for itself (a group send from another surface, a remote status probe)
    is still a message to this session, but it is not one you typed here — and a row that says
    "You" over a message you never wrote is the kind of small lie that makes the rest suspect. */
const AUTHOR = { client: "You", server: "Sent by Sova" } as const;

export function UserTurn(props: {
  text: string;
  time?: string;
  state?: LiveUserState;
  origin?: "client" | "server";
  /** The Overseer sent this message (its `sova-overseer-sent` marker names this row). */
  overseer?: boolean;
  /** A baton participant's name (its `sova-baton-sent` marker names this row, §app.baton/attribution). */
  sender?: string;
  /** Another session sent this message (its `sova-session-sent` marker, §chat.profiles/delivery). */
  fromSession?: { sessionId: string; title: string; hop?: number };
  images?: string[];
  attachments?: TmpAttachment[];
}) {
  const author = () =>
    props.fromSession ? "From a session" : props.overseer ? "Overseer" : (props.sender ?? AUTHOR[props.origin ?? "client"]);
  // The model reads the header line; the row shows it as the sender header instead.
  const text = () => (props.fromSession ? stripSessionHeader(props.text) : props.text);
  return (
    <>
    <Show when={props.fromSession}>
      {(from) => (
        <p class="session-sender">
          <Icon name="network" small />
          <span>
            From <a href={`#/sid/${encodeURIComponent(from().sessionId)}`}>{from().title || "another session"}</a>
          </span>
          <Show when={from().hop !== undefined}>
            <span class="text-muted">· hop {from().hop}</span>
          </Show>
        </p>
      )}
    </Show>
    <article
      class="message message-user"
      classList={{ "message-from-session": !!props.fromSession }}
      aria-label={props.time ? `${author()}, ${stampTime(props.time)}` : author()}
    >
      <div class="message-head">
        <Show when={props.overseer} fallback={<span class="message-author">{author()}</span>}>
          <span class="message-author overseer-author" title="Sent by the Overseer">
            <Icon name="eye" small />
            Overseer
          </span>
        </Show>
        <Stamp iso={props.time} />
        <Show when={props.state && PENDING_LABEL[props.state]}>
          {(label) => <span class="message-pending">{label()}</span>}
        </Show>
      </div>
      <ImageStrip images={props.images} where="in your message" />
      <For each={props.attachments}>{(a) => <PathAttachment attachment={a} where="in your message" />}</For>
      <Show when={text()}>
        <div class="message-body message-text">{text()}</div>
      </Show>
    </article>
    </>
  );
}

export function AssistantText(props: {
  text: string;
  author: string;
  /** Full "provider/model" behind `author` (its short form), for hover. */
  model?: string;
  time?: string;
  streaming?: boolean;
  showHead: boolean;
  attachments?: TmpAttachment[];
  /** The reply's own measurement (its entry's `reply` fact): the head's time shows it. Absent: the
      head is as it always was. */
  timing?: ReplyTiming;
}) {
  const author = () => <span class="message-author text-mono" title={props.model}>{props.author}</span>;
  return (
    <article
      class="message"
      classList={{ "message-streaming": !!props.streaming }}
      aria-label={props.time ? `${props.author}, ${stampTime(props.time)}` : props.author}
    >
      <Show when={props.showHead || props.streaming}>
        <Show
          when={!props.streaming && !!props.time && props.timing}
          fallback={
            <div class="message-head">
              {author()}
              <Show when={props.streaming}>
                <span class="live-dot" />
              </Show>
              <Stamp iso={props.time} />
            </div>
          }
        >
          {(t) => <ReplyTimingHead timing={t()} author={author()} stamp={<Stamp iso={props.time} />} />}
        </Show>
      </Show>
      <Markdown text={props.text} streaming={props.streaming} attachments={props.attachments} />
    </article>
  );
}

export function Thinking(props: { text: string; streaming?: boolean }) {
  const preview = () => {
    const first = props.text.trim().split("\n")[0] ?? "";
    return first.length > 80 ? `${first.slice(0, 80)}…` : first;
  };
  return (
    <details class="disclosure">
      <summary class="disclosure-summary">
        <Icon name="chevron-right" small class="icon-twist" />
        <span class="disclosure-label">Thinking</span>
        <Show when={props.streaming}>
          <span class="live-dot" />
        </Show>
        <Show when={preview()}>
          <span class="disclosure-preview">· {preview()}</span>
        </Show>
      </summary>
      <div class="disclosure-body thinking-body">{props.text}</div>
    </details>
  );
}
