// A setup branch's dry run on every row and card that shows it (§app.merge-queue/dry-runs): its line with the one
// sentence and the What's a dry run? link, the explainer it opens (§app.merge-queue/dry-run-explainer), Run Dry Run /
// Run Dry Run Again / Stop Dry Run, and Fix with Fix in New Chat on a failure (§app.merge-queue/fix). The words are
// lib/dry-run's, so every screen says the same thing.
import { createSignal, For, onCleanup, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { DRY_RUN_DOCS, DRY_RUN_LINK, DRY_RUN_SENTENCE, dryRunLine, explainerWords, fixToast, fixWhyNot, newChatLine, newChatToast, newChatWhyNot, startedToast, stoppedToast, type BranchDryRun, type BranchFailure, type FixOffer } from "../lib/dry-run";
import { fixIt, refusal, runDryRun, stopTheDryRun } from "../lib/merge-queue-client";
import { projectSessionHref } from "../lib/projects-route";
import { announce, toast } from "../lib/ui-state";
import { ActionMenu, type ActionMenuItemProps } from "./ActionMenu";
import { Icon, trapFocus } from "./ui";

/** The explainer over the screen: a dialog with room, a bottom sheet on a phone (the design system's .modal), closed by
    Close, Escape or the scrim; focus goes back to the link that opened it (trapFocus). */
export function DryRunExplainer(props: { target: string; onClose(): void }) {
  const w = () => explainerWords(props.target);
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    e.preventDefault();
    e.stopPropagation();
    props.onClose();
  };
  document.addEventListener("keydown", onKey, true);
  onCleanup(() => document.removeEventListener("keydown", onKey, true));
  return (
    <Portal>
      <div class="scrim" onClick={() => props.onClose()} />
      <div class="modal dry-run-explainer" role="dialog" aria-modal="true" aria-labelledby="dry-run-explainer-title" ref={(el) => trapFocus(el)}>
        <div class="modal-head">
          <h2 class="modal-title" id="dry-run-explainer-title">
            {w().title}
          </h2>
          <button type="button" class="button button-ghost button-icon" aria-label="Close" onClick={() => props.onClose()}>
            <Icon name="close" />
          </button>
        </div>
        <div class="modal-body stack-2 prose">
          <p>{w().intro}</p>
          <For each={w().parts}>
            {(part) => (
              <>
                <h3 class="text-heading-s">{part.heading}</h3>
                <p>{part.body}</p>
              </>
            )}
          </For>
        </div>
        <div class="modal-foot">
          <a class="button button-sm button-ghost" href={DRY_RUN_DOCS} target="_blank" rel="noopener">
            {w().docs}
            <Icon name="external" small />
          </a>
          <button type="button" class="button button-sm" onClick={() => props.onClose()}>
            Close
          </button>
        </div>
      </div>
    </Portal>
  );
}

/** The What's a dry run? link: a text button that opens the explainer. */
export function DryRunLink(props: { target: string }) {
  const [open, setOpen] = createSignal(false);
  return (
    <>
      <button
        type="button"
        class="button-link dry-run-link"
        aria-haspopup="dialog"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        {DRY_RUN_LINK}
      </button>
      <Show when={open()}>
        <DryRunExplainer target={props.target} onClose={() => setOpen(false)} />
      </Show>
    </>
  );
}

/** The sentence beside every dry-run chip and line, then the link. */
export function DryRunWhat(props: { target: string; class?: string }) {
  return (
    <p class={`text-caption text-muted dry-run-what${props.class ? ` ${props.class}` : ""}`}>
      {DRY_RUN_SENTENCE} <DryRunLink target={props.target} />
    </p>
  );
}

/** A row's dry-run lines (its chip is the caller's): the state's line, Land's stand line, an older commit's note, then
    the sentence and the link. `seeChecks`: a link to its run page. */
export function DryRunLines(props: { dryRun: BranchDryRun; target: string; chatTitle?: (session: string) => string | undefined; seeChecks?: string; class?: string }) {
  const l = () => dryRunLine(props.dryRun, props.target, props.chatTitle);
  const cls = props.class ?? "list-meta";
  return (
    <>
      <p class={`${cls} dry-run-line`} data-dry-run={props.dryRun.state}>
        {l().text}
        <Show when={props.seeChecks}>
          {(href) => (
            <>
              {" "}
              <a href={href()} onClick={(e) => e.stopPropagation()}>
                View Checks
              </a>
            </>
          )}
        </Show>
      </p>
      <Show when={l().stand}>{(s) => <p class={`${cls} text-muted`}>{s()}</p>}</Show>
      <Show when={l().older}>{(o) => <p class={`${cls} text-muted`}>{o()}</p>}</Show>
      <DryRunWhat target={props.target} class={cls} />
    </>
  );
}

/** One press's pending state and refusal, announced; a done press toasts its words. */
export function usePress(onChanged?: () => void) {
  const [busy, setBusy] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const press = async <T,>(key: string, call: () => Promise<{ ok: boolean; error?: { message: string }; value?: T }>, done: string | ((v: T | undefined) => string), after?: (v: T | undefined) => void) => {
    if (busy()) return;
    setBusy(key);
    setError(null);
    try {
      const r = await call();
      const no = refusal(r);
      if (no) {
        setError(no);
        announce(no);
      } else {
        const words = typeof done === "string" ? done : done(r.value);
        toast(words);
        announce(words);
        onChanged?.();
        after?.(r.value);
      }
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      setError(m);
      announce(m);
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, setError, press };
}

/** Run Dry Run / Run Dry Run Again, or Stop Dry Run, as the row's state asks. A busy merge copy never refuses Run: it
    waits its turn (the row then reads Dry run waiting, with Stop). */
export function DryRunButton(props: {
  projectId: string;
  branch: string;
  commit: string;
  kind: "run" | "again" | "stop";
  /** Stop: the running dry run's run, or the waiting one's id. */
  run?: string;
  waiting?: string;
  press: ReturnType<typeof usePress>;
  class?: string;
}) {
  const label = () => (props.kind === "stop" ? "Stop Dry Run" : props.kind === "again" ? "Run Dry Run Again" : "Run Dry Run");
  const go = () => {
    if (props.kind === "stop") {
      const which = props.run ? { run: props.run } : props.waiting ? { waiting: props.waiting } : null;
      if (!which) return props.press.setError("Sova is still reading this dry run: try again in a moment.");
      void props.press.press("stop", () => stopTheDryRun(props.projectId, which), stoppedToast(props.branch));
    } else void props.press.press("run", () => runDryRun(props.projectId, props.branch, props.commit), (v: { waiting?: { after: string } } | undefined) => (v?.waiting ? `The dry run of ${props.branch} waits for the merge copy: it starts after ${v.waiting.after}.` : startedToast(props.branch, props.commit)));
  };
  return (
    <button
      type="button"
      class={`button button-sm${props.class ? ` ${props.class}` : ""}`}
      data-dry-run-act={props.kind}
      aria-label={`${label()} of ${props.branch}`}
      title={props.kind === "stop" ? "Stops it and frees the merge copy. Nothing is blamed; the branch needs a new dry run." : "Runs the merge checks this branch adds or changes on its exact commit. Nothing lands from it."}
      disabled={!!props.press.busy()}
      aria-busy={props.press.busy() === (props.kind === "stop" ? "stop" : "run") ? "true" : undefined}
      onClick={(e) => {
        e.stopPropagation();
        go();
      }}
    >
      {label()}
    </button>
  );
}

/** What Fix, Fix in New Chat and the ▾ menu act on. */
export interface FixTarget {
  projectId: string;
  target: string;
  branch?: string;
  commit?: string;
  failure?: BranchFailure;
  offer?: FixOffer;
  /** A check broken on the target (no branch): Fix in New Chat only. */
  check?: { id: string; label: string; run: string };
  /** A chat's title by its id: Fix's toast names the chat it sent to. */
  chatTitle?: (session: string) => string | undefined;
}

/** Fix and Fix in New Chat's presses: each opens the chat it sent to. A refusal is said under the row. */
export function createFix(t: () => FixTarget, press: ReturnType<typeof usePress>) {
  const body = (newChat: boolean) => {
    const x = t();
    if (x.check) return { check: x.check.id, run: x.check.run, newChat: true };
    return { ...(x.branch ? { branch: x.branch } : {}), ...(x.commit ? { commit: x.commit } : {}), ...(x.failure ? { run: x.failure.run } : {}), ...(newChat ? { newChat: true } : {}) };
  };
  const checkLabel = () => t().check?.label ?? t().failure?.checks[0]?.label ?? "the failing check";
  const open = (v: { path: string } | undefined) => {
    if (v?.path) location.hash = projectSessionHref(t().projectId, v.path);
  };
  const chatName = () => {
    const o = t().offer;
    return (o?.chat.ok && t().chatTitle?.(o.chat.session)) || "its chat";
  };
  return {
    fix: () => {
      const no = fixWhyNot(t().offer);
      if (no) {
        press.setError(no);
        announce(no);
        return;
      }
      void press.press("fix", () => fixIt(t().projectId, body(false)), () => fixToast(chatName()), open);
    },
    newChat: () => {
      const no = newChatWhyNot(t().offer);
      if (no) {
        press.setError(no);
        announce(no);
        return;
      }
      const on = t().check ? "new-branch" : (t().offer?.newChat.on ?? "this-branch");
      void press.press("new-chat", () => fixIt(t().projectId, body(true)), newChatToast(checkLabel(), t().branch ?? t().target, on, t().target), open);
    },
  };
}

/** Fix in Land's place, in every case, with its ▾: Fix in New Chat first, then `items` (the action Fix took the place
    of, Land Anyway, then the menu's usual items). Fix is never a dead button: refused now, it says why on press and on
    hover. */
export function FixSplit(props: { fix: FixTarget; press: ReturnType<typeof usePress>; items?: (Item: (p: ActionMenuItemProps) => JSX.Element) => JSX.Element; onMenuOpen?(): void }) {
  const f = createFix(() => props.fix, props.press);
  const branch = () => props.fix.branch ?? props.fix.check?.label ?? "it";
  const why = () => fixWhyNot(props.fix.offer);
  const newWhy = () => newChatWhyNot(props.fix.offer);
  return (
    <div class="button-split wt-queue-split dry-run-fix">
      <button
        type="button"
        class="button button-sm button-primary"
        data-fix=""
        aria-label={`Fix ${branch()}`}
        title={why() ?? "Sends the failure to the branch's chat: it explains what's wrong and proposes a fix, then waits for you."}
        aria-disabled={why() ? "true" : undefined}
        aria-busy={props.press.busy() === "fix" ? "true" : undefined}
        disabled={!!props.press.busy()}
        onClick={(e) => {
          e.stopPropagation();
          f.fix();
        }}
      >
        Fix
      </button>
      <ActionMenu label={`More ways to fix ${branch()}`} title="More ways to fix" icon="chevron-down" ghost={false} menuName={`Fix ${branch()}`} panelClass="wt-land-menu" returnFocus onToggle={(o) => o && props.onMenuOpen?.()}>
        {(menu) => (
          <>
            <menu.Item label="Fix in New Chat" aria={`Fix ${branch()} in a new chat`} description={newChatLine(props.fix.offer, props.fix.target)} disabled={newWhy() ?? undefined} onRun={() => f.newChat()} />
            {props.items?.((p) => menu.Item(p))}
          </>
        )}
      </ActionMenu>
    </div>
  );
}

/** Fix in New Chat as a plain button (a check broken on the target: no branch of its own). */
export function FixNewChatButton(props: { fix: FixTarget; press: ReturnType<typeof usePress> }) {
  const f = createFix(() => props.fix, props.press);
  const why = () => newChatWhyNot(props.fix.offer);
  return (
    <button
      type="button"
      class="button button-sm"
      data-fix-new-chat=""
      aria-label={`Fix ${props.fix.check?.label ?? props.fix.branch ?? "it"} in a new chat`}
      title={why() ?? newChatLine(props.fix.offer ?? { chat: { ok: false, why: "" }, newChat: { ok: true, on: "new-branch" } }, props.fix.target)}
      aria-disabled={why() ? "true" : undefined}
      aria-busy={props.press.busy() === "new-chat" ? "true" : undefined}
      disabled={!!props.press.busy()}
      onClick={(e) => {
        e.stopPropagation();
        f.newChat();
      }}
    >
      Fix in New Chat
    </button>
  );
}
