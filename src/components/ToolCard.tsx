import { createSignal, Match, Show, Switch } from "solid-js";
import { argsSummary } from "../lib/message";
import { prettyJson } from "../lib/format";
import { copyText } from "../lib/ui-state";
import { Chip, CopyButton, Icon, type IconName } from "./ui";

/** "none": no result and nothing is streaming, so none is coming. */
export type ToolStatus = "running" | "done" | "error" | "none";

const MAX_LINES = 400;
const HEAD_LINES = 200;

function toolIcon(name: string): IconName {
  if (name === "bash") return "terminal";
  if (["read", "write", "edit"].includes(name)) return "file";
  if (["grep", "find", "ls"].includes(name)) return "search";
  return "more";
}

/** A tool call and its result, collapsed to one mono line until opened. */
export function ToolCard(props: {
  name: string;
  args: unknown;
  /** Raw argument JSON while the model is still streaming it. */
  argsText?: string;
  status: ToolStatus;
  output?: string;
}) {
  const [showAll, setShowAll] = createSignal(false);
  const hasArgs = () => props.args !== undefined || !!props.argsText;
  const failed = () => props.status === "error";
  const lines = () => (props.output ?? "").split("\n");
  const shown = () => (showAll() || lines().length <= MAX_LINES ? props.output : lines().slice(0, HEAD_LINES).join("\n"));
  const summary = () => argsSummary(props.args);

  return (
    <details class="toolcard">
      <summary class="toolcard-summary">
        <Icon name="chevron-right" small class="icon-twist" />
        <Icon name={toolIcon(props.name)} small />
        <span class="toolcard-name">{props.name}</span>
        <span class="toolcard-arg" title={summary()}>
          {summary()}
        </span>
        <Switch>
          <Match when={props.status === "running"}>
            <Chip tone="accent" live>
              Running
            </Chip>
          </Match>
          <Match when={props.status === "done"}>
            <Chip tone="success">Done</Chip>
          </Match>
          <Match when={failed()}>
            <Chip tone="error">Failed</Chip>
          </Match>
          <Match when={props.status === "none"}>
            <Chip>No result</Chip>
          </Match>
        </Switch>
      </summary>
      <div class="toolcard-body">
        <Show when={hasArgs()}>
          <div class="toolcard-section">
            <div class="toolcard-section-label">Arguments</div>
            <pre>{props.args !== undefined ? prettyJson(props.args) : props.argsText}</pre>
          </div>
        </Show>
        <Show when={props.output}>
          <div class="toolcard-section">
            <div class="toolcard-section-label">
              {failed() ? "Error" : "Output"}
              <CopyButton label="Copy Output" text={() => props.output ?? ""} onCopy={(t) => copyText(t, "Copied output.")} />
            </div>
            <pre class="toolcard-output" classList={{ "toolcard-output-error": failed() }}>
              {shown()}
            </pre>
            <Show when={!showAll() && lines().length > MAX_LINES}>
              <button type="button" class="button button-sm" onClick={() => setShowAll(true)}>
                Show All {lines().length.toLocaleString("en-US")} Lines
              </button>
            </Show>
          </div>
        </Show>
      </div>
    </details>
  );
}
