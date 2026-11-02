import { createSignal, Show } from "solid-js";
import type { VerbResult } from "../../shared/project-contract";
import { refusal, saveChecks, tryOnMain, type OnboardChecks } from "../lib/merge-queue-client";
import { mergeRunHref } from "../lib/projects-route";
import { announce, toast } from "../lib/ui-state";
import { parseCheckList, type MergeQueueView } from "../lib/merge-queue";
import { HeadsStrip } from "./MergeQueueTab";
import { Banner } from "./ui";
import { QueueChip } from "./WorktreesModal";

type Tried = { state: "idle" } | { state: "running" } | { state: "passed"; run?: string; took?: string } | { state: "failed"; why: string; run?: string };

/**
 * A project whose queue isn't set up: say what should pass before anything lands. Run a command (and
 * what to start first), or say once that it has no automated tests. Try It on Main runs it on the
 * target alone in the merge copy, logged; only then does Save Checks show.
 */
export function MergeOnboarding(props: { projectId: string; name: string; view: MergeQueueView; onSaved(): void }) {
  const [choice, setChoice] = createSignal<"list" | "command" | "none">("command");
  const [list, setList] = createSignal("");
  const [command, setCommand] = createSignal("");
  const [takes, setTakes] = createSignal("");
  const [requires, setRequires] = createSignal("");
  const [tried, setTried] = createSignal<Tried>({ state: "idle" });
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const target = () => props.view.target;

  const checks = (): OnboardChecks =>
    choice() === "none"
      ? { kind: "none" }
      : choice() === "list"
        ? { kind: "list", checks: parseCheckList(list()).checks }
        : { kind: "command", command: command().trim(), ...(Number(takes()) > 0 ? { takesMin: Number(takes()) } : {}), ...(requires().trim() ? { requires: requires().trim() } : {}) };
  /** Any change after a try asks for a new try. */
  const changed = () => setTried({ state: "idle" });
  const runOf = (r: VerbResult) => r.merge?.run?.id;

  const doTry = async () => {
    if (choice() === "command" && !command().trim()) {
      setError("Type the command that runs the project's tests.");
      return;
    }
    if (choice() === "list") {
      const { checks: got, bad } = parseCheckList(list());
      if (bad.length || got.length === 0) {
        setError(got.length === 0 ? "List at least 1 check: a name, a colon, then its command." : `Line ${bad.join(", ")} needs a name, a colon, then its command.`);
        return;
      }
    }
    setError(null);
    setTried({ state: "running" });
    announce(`Trying it on ${target()}.`);
    try {
      const r = await tryOnMain(props.view.root, checks());
      const no = refusal(r);
      const t: Tried = no ? { state: "failed", why: no, run: runOf(r) } : { state: "passed", run: runOf(r) };
      setTried(t);
      announce(no ? `It didn't pass on ${target()}: ${no}` : `Passed on ${target()}. You can save it.`);
    } catch (err) {
      setTried({ state: "failed", why: err instanceof Error ? err.message : String(err) });
    }
  };
  const doSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const no = refusal(await saveChecks(props.view.root, checks()));
      if (no) setError(no);
      else {
        toast("Saved. The merge queue runs here now.");
        announce("Saved. The merge queue runs here now.");
        props.onSaved();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div class="stack mq-body mq-onboard">
      <HeadsStrip view={props.view} />
      <div class="cluster">
        <h2 class="orgs-h2" id="mq-title">
          Merge queue
        </h2>
        <QueueChip row={{ label: "Not set up", tone: "warn" }} />
      </div>
      <div class="mq-card stack">
        <div>
          <h3 class="text-heading-s">Before the queue can land anything here, tell us what should pass.</h3>
          <p class="text-caption text-muted">{props.name} doesn't declare any checks yet.</p>
        </div>
        <div role="radiogroup" aria-label="Checks" class="stack-2">
          <label class="mq-choice">
            <input
              type="radio"
              name={`mq-checks-${props.projectId}`}
              checked={choice() === "list"}
              onChange={() => {
                setChoice("list");
                changed();
              }}
            />
            <span>
              <strong>List its checks</strong>
              <span class="text-caption mq-choice-desc">Each one runs on every branch, merged onto {target()}, in this order.</span>
            </span>
          </label>
          <Show when={choice() === "list"}>
            <div class="mq-fields">
              <div class="field mq-field-wide">
                <label class="field-label" for={`mq-list-${props.projectId}`}>
                  Checks
                </label>
                <textarea
                  id={`mq-list-${props.projectId}`}
                  class="textarea input-mono"
                  rows="4"
                  placeholder={"Typecheck: npm run typecheck\nUnit tests: npm test"}
                  value={list()}
                  onInput={(e) => {
                    setList(e.currentTarget.value);
                    changed();
                  }}
                />
                <p class="field-hint">One per line: a name, a colon, then its command.</p>
              </div>
            </div>
          </Show>
          <label class="mq-choice">
            <input
              type="radio"
              name={`mq-checks-${props.projectId}`}
              checked={choice() === "command"}
              onChange={() => {
                setChoice("command");
                changed();
              }}
            />
            <span>
              <strong>Run a command</strong>
              <span class="text-caption mq-choice-desc">Each branch runs it, merged onto {target()}. The merge thread may add checks, never remove this one.</span>
            </span>
          </label>
          <Show when={choice() === "command"}>
            <div class="mq-fields">
              <div class="field mq-field-wide">
                <label class="field-label" for={`mq-cmd-${props.projectId}`}>
                  Command
                </label>
                <input
                  id={`mq-cmd-${props.projectId}`}
                  class="input input-mono"
                  placeholder="npm test"
                  value={command()}
                  onInput={(e) => {
                    setCommand(e.currentTarget.value);
                    changed();
                  }}
                />
              </div>
              <div class="field">
                <label class="field-label" for={`mq-takes-${props.projectId}`}>
                  Usually takes (min)
                </label>
                <input id={`mq-takes-${props.projectId}`} class="input" inputmode="numeric" value={takes()} onInput={(e) => setTakes(e.currentTarget.value)} />
              </div>
              <div class="field">
                <label class="field-label" for={`mq-req-${props.projectId}`}>
                  Start first
                </label>
                <input
                  id={`mq-req-${props.projectId}`}
                  class="input"
                  placeholder="Nothing"
                  value={requires()}
                  onInput={(e) => {
                    setRequires(e.currentTarget.value);
                    changed();
                  }}
                />
                <p class="field-hint">A service of the project's definition, such as its database.</p>
              </div>
            </div>
          </Show>
          <label class="mq-choice">
            <input
              type="radio"
              name={`mq-checks-${props.projectId}`}
              checked={choice() === "none"}
              onChange={() => {
                setChoice("none");
                changed();
              }}
            />
            <span>
              <strong>This project has no automated tests</strong>
              <span class="text-caption mq-choice-desc">Branches land after a clean merge. Each landing says "No checks declared", never "passed".</span>
            </span>
          </label>
        </div>
        <div>
          <h4 class="text-caption mq-steps-head">What happens to each approved branch, one at a time</h4>
          <ol class="text-caption mq-what">
            <li>It's merged onto {target()} in a separate copy. Your worktree isn't touched.</li>
            <Show when={choice() !== "none"} fallback={<li>{target()} moves to that merged commit.</li>}>
              <Show
                when={choice() === "command"}
                fallback={<li>We run {parseCheckList(list()).checks.length || "your"} {parseCheckList(list()).checks.length === 1 ? "check" : "checks"} there, in order.</li>}
              >
                <li>
                  We run <span class="text-mono">{command().trim() || "your command"}</span> there{requires().trim() ? `, after starting ${requires().trim()}` : ""}.
                </li>
              </Show>
              <li>If {choice() === "list" ? "they pass" : "it passes"}, {target()} moves to exactly that commit.</li>
            </Show>
            <li>{target()} is pushed to origin, when it has one.</li>
          </ol>
        </div>
        <Show when={tried().state === "passed"}>
          <Banner tone="success" title={`Ran on ${target()} · passed. The queue can run here.`} />
        </Show>
        <Show when={tried().state === "failed" ? (tried() as Extract<Tried, { state: "failed" }>) : null}>
          {(f) => (
            <Banner
              tone="error"
              title={`The queue can't run here yet: it failed on ${target()} itself.`}
              body={`${f().why} No branch was blamed. Fix it, then try again.`}
              action={
                <Show when={f().run}>
                  {(r) => (
                    <a class="button button-sm" href={mergeRunHref(props.projectId, r())}>
                      View Log
                    </a>
                  )}
                </Show>
              }
            />
          )}
        </Show>
        <Show when={error()}>{(m) => <p class="text-caption mq-error" role="alert">{m()}</p>}</Show>
        <div class="button-row">
          <Show
            when={tried().state === "passed"}
            fallback={
              <button type="button" class="button button-primary" disabled={tried().state === "running"} aria-busy={tried().state === "running" ? "true" : undefined} onClick={() => void doTry()}>
                {tried().state === "running" ? `Trying on ${target()}…` : choice() === "none" ? "Try the Merge Copy" : `Try It on ${cap(target())}`}
              </button>
            }
          >
            <button type="button" class="button button-primary" disabled={saving()} onClick={() => void doSave()}>
              Save Checks
            </button>
          </Show>
        </div>
      </div>
    </div>
  );
}

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
