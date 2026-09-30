import { Show } from "solid-js";
import { singletonRunningText } from "../../shared/profiles";
import { profileIconName } from "../lib/profiles";
import { Icon } from "./ui";

/** A tool call the profile features draw as a card (§chat.profiles/delivery, §app.overseer/tools). */
export type ProfileToolCard =
  | { kind: "sent"; target: { id: string; title: string }; queued: boolean; steer: boolean; hop: number }
  | { kind: "send-refused"; target: string; error: string }
  | { kind: "started"; session: { id: string; title: string }; profile: { label: string; icon: string } }
  | { kind: "singleton"; profile: { label: string; icon: string }; running: { id: string; title: string }; open: string };

const obj = (v: unknown): Record<string, any> | null => (v && typeof v === "object" ? (v as Record<string, any>) : null);

/** The card a tool call reads as, or null for the plain tool card. */
export function profileToolCard(name: string | undefined, status: string, args: unknown, details: unknown, output: string | undefined): ProfileToolCard | null {
  const d = obj(details);
  if (name === "session_send") {
    if (status === "done" && d && obj(d.target) && typeof d.target.id === "string")
      return { kind: "sent", target: { id: d.target.id, title: String(d.target.title ?? d.target.id) }, queued: d.queued === true, steer: d.kind === "steer", hop: Number(d.hop) || 1 };
    if (status === "error") return { kind: "send-refused", target: String(obj(args)?.session ?? "a session"), error: (output ?? "").replace(/^ERROR:\s*/, "").trim() };
    return null;
  }
  if (name === "sova_create_session" && status === "done" && d) {
    if (d.refused === "singleton" && obj(d.profile) && obj(d.running))
      return { kind: "singleton", profile: { label: String(d.profile.label), icon: String(d.profile.icon) }, running: { id: String(d.running.id), title: String(d.running.title) }, open: String(d.open ?? "Open It") };
    if (obj(d.profile) && typeof d.id === "string")
      return { kind: "started", session: { id: d.id, title: String(d.title ?? "New session") }, profile: { label: String(d.profile.label), icon: String(d.profile.icon) } };
  }
  return null;
}

const href = (id: string) => `#/sid/${encodeURIComponent(id)}`;

export function ProfileToolCardView(props: { card: ProfileToolCard }) {
  const c = props.card;
  switch (c.kind) {
    case "sent":
      return (
        <section class="card profile-card" aria-label={`${c.queued ? "Queued in" : "Sent to"} ${c.target.title}`}>
          <div class="card-head">
            <Icon name="network" small />
            <h3 class="card-title">
              {c.queued ? (c.steer ? "Queued as a steer in " : "Queued in ") : "Sent to "}
              <a href={href(c.target.id)}>{c.target.title}</a>
            </h3>
            <span class="text-muted">hop {c.hop}</span>
          </div>
        </section>
      );
    case "send-refused":
      return (
        <section class="card profile-card profile-card-refused" aria-label="Not sent">
          <div class="card-head">
            <Icon name="alert-circle" small />
            <h3 class="card-title">
              Not sent to <a href={href(c.target)}>{c.target}</a>
            </h3>
          </div>
          <p class="card-body">{c.error}</p>
        </section>
      );
    case "started":
      return (
        <section class="card profile-card" aria-label={`Started from ${c.profile.label}`}>
          <div class="card-head">
            <Icon name={profileIconName(c.profile.icon)} small />
            <h3 class="card-title">Started from {c.profile.label}</h3>
            <span class="text-muted">New session</span>
          </div>
          <p class="card-body">
            <a class="button button-sm" href={href(c.session.id)}>
              Open Session
            </a>{" "}
            <span class="text-muted">{c.session.title}</span>
          </p>
        </section>
      );
    case "singleton":
      return (
        <section class="card profile-card profile-card-refused" aria-label={singletonRunningText(c.profile.label)}>
          <div class="card-head">
            <Icon name="alert-circle" small />
            <h3 class="card-title">{singletonRunningText(c.profile.label)}</h3>
          </div>
          <p class="card-body">
            <a class="button button-sm button-primary" href={href(c.running.id)}>
              {c.open}
            </a>
            <Show when={c.running.title}>
              {" "}
              <span class="text-muted">{c.running.title}</span>
            </Show>
          </p>
        </section>
      );
  }
}
