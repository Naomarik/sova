import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
import { argsSummary, isObj, str } from "../lib/message";
import { prettyJson } from "../lib/format";
import { highlightByPath } from "../lib/markdown";
import { copyText } from "../lib/ui-state";
import type { TmpAttachment } from "../../shared/protocol";
import { ImageStrip } from "./ImageStrip";
import { PathAttachment } from "./PathAttachment";
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

interface Code {
  html: string;
  lang: string;
}
interface EditView {
  before: Code;
  after: Code;
  newText: string;
}
/** File content a write/edit call carries, highlighted by its path; null keeps the JSON view. */
type FileView = { kind: "write"; path: string; content: string; code: Code } | { kind: "edit"; path: string; edits: EditView[] };

/** `{edits:[{oldText,newText}]}`, or the older single `{oldText,newText}`; null if any is malformed. */
function editsOf(args: Record<string, unknown>): { oldText: string; newText: string }[] | null {
  const list: unknown[] = Array.isArray(args.edits) ? args.edits : [args];
  const out: { oldText: string; newText: string }[] = [];
  for (const e of list) {
    const oldText = isObj(e) ? str(e.oldText) : undefined;
    const newText = isObj(e) ? str(e.newText) : undefined;
    if (oldText === undefined || newText === undefined) return null;
    out.push({ oldText, newText });
  }
  return out.length > 0 ? out : null;
}

function fileView(name: string, args: unknown): FileView | null {
  const path = isObj(args) ? str(args.path) : undefined;
  if (!isObj(args) || path === undefined) return null;
  const content = str(args.content);
  if (name === "write" && content !== undefined) return { kind: "write", path, content, code: highlightByPath(content, path) };
  const edits = name === "edit" ? editsOf(args) : null;
  if (!edits) return null;
  return {
    kind: "edit",
    path,
    edits: edits.map((e) => ({ before: highlightByPath(e.oldText, path), after: highlightByPath(e.newText, path), newText: e.newText })),
  };
}

const codeClass = (lang: string) => (lang ? `hljs language-${lang}` : undefined);

/** A tool call and its result, collapsed to one mono line until opened. */
export function ToolCard(props: {
  name: string;
  args: unknown;
  /** Raw argument JSON while the model is still streaming it. */
  argsText?: string;
  status: ToolStatus;
  output?: string;
  images?: string[];
  /** /tmp image paths named in the output. */
  attachments?: TmpAttachment[];
}) {
  const [showAll, setShowAll] = createSignal(false);
  const hasArgs = () => props.args !== undefined || !!props.argsText;
  const failed = () => props.status === "error";
  const lines = () => (props.output ?? "").split("\n");
  const shown = () => (showAll() || lines().length <= MAX_LINES ? props.output : lines().slice(0, HEAD_LINES).join("\n"));
  const summary = () => argsSummary(props.args);
  // Highlighting is string work; memos keep it off unrelated re-renders. Streaming args
  // (props.args still undefined) stay plain JSON text.
  const file = createMemo(() => (props.args === undefined ? null : fileView(props.name, props.args)));
  const written = () => {
    const f = file();
    return f?.kind === "write" ? f : null;
  };
  const edited = () => {
    const f = file();
    return f?.kind === "edit" ? f : null;
  };
  const readPath = () => (props.name === "read" && !failed() && isObj(props.args) ? str(props.args.path) : undefined);
  const readCode = createMemo((): Code | null => {
    const path = readPath();
    const code = path === undefined ? null : highlightByPath(shown() ?? "", path);
    return code?.lang ? code : null;
  });

  return (
    <details class="toolcard">
      <summary class="toolcard-summary">
        <Icon name="chevron-right" small class="icon-twist" />
        <Icon name={toolIcon(props.name)} small />
        <span class="toolcard-name">{props.name}</span>
        <span class="toolcard-arg" title={summary()}>
          {summary()}
        </span>
        <Show when={props.images && props.images.length > 0}>
          <span class="toolcard-images" title={`${props.images!.length} ${props.images!.length === 1 ? "image" : "images"}`}>
            <Icon name="image" small />
            {props.images!.length}
            <span class="visually-hidden">{props.images!.length === 1 ? "image" : "images"}</span>
          </span>
        </Show>
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
        <Switch
          fallback={
            <Show when={hasArgs()}>
              <div class="toolcard-section">
                <div class="toolcard-section-label">Arguments</div>
                <pre>{props.args !== undefined ? prettyJson(props.args) : props.argsText}</pre>
              </div>
            </Show>
          }
        >
          <Match when={written()}>
            {(v) => (
              <div class="toolcard-section">
                <div class="toolcard-section-label">
                  Content
                  <CopyButton label="Copy Code" text={() => v().content} onCopy={(t) => copyText(t, "Copied code.")} />
                </div>
                <div class="toolcard-path">{v().path}</div>
                <pre class="toolcard-code">
                  <code class={codeClass(v().code.lang)} innerHTML={v().code.html} />
                </pre>
              </div>
            )}
          </Match>
          <Match when={edited()}>
            {(v) => (
              <>
                <div class="toolcard-path">{v().path}</div>
                <For each={v().edits}>
                  {(e, i) => {
                    const of = () => (v().edits.length > 1 ? ` · ${i() + 1} of ${v().edits.length}` : "");
                    return (
                      <div class="toolcard-section">
                        <div class="toolcard-section-label">Replaced{of()}</div>
                        <pre class="toolcard-code toolcard-code-del">
                          <code class={codeClass(e.before.lang)} innerHTML={e.before.html} />
                        </pre>
                        <div class="toolcard-section-label">
                          With{of()}
                          <CopyButton label="Copy Code" text={() => e.newText} onCopy={(t) => copyText(t, "Copied code.")} />
                        </div>
                        <pre class="toolcard-code toolcard-code-add">
                          <code class={codeClass(e.after.lang)} innerHTML={e.after.html} />
                        </pre>
                      </div>
                    );
                  }}
                </For>
              </>
            )}
          </Match>
        </Switch>
        <Show when={props.output}>
          <div class="toolcard-section">
            <div class="toolcard-section-label">
              {failed() ? "Error" : "Output"}
              <CopyButton label="Copy Output" text={() => props.output ?? ""} onCopy={(t) => copyText(t, "Copied output.")} />
            </div>
            <Show
              when={readCode()}
              fallback={
                <pre class="toolcard-output" classList={{ "toolcard-output-error": failed() }}>
                  {shown()}
                </pre>
              }
            >
              {(code) => (
                <pre class="toolcard-output toolcard-code">
                  <code class={codeClass(code().lang)} innerHTML={code().html} />
                </pre>
              )}
            </Show>
            <Show when={!showAll() && lines().length > MAX_LINES}>
              <button type="button" class="button button-sm" onClick={() => setShowAll(true)}>
                Show All {lines().length.toLocaleString("en-US")} Lines
              </button>
            </Show>
          </div>
        </Show>
        <Show when={props.images && props.images.length > 0}>
          <div class="toolcard-section">
            <div class="toolcard-section-label">Images · {props.images!.length}</div>
            <ImageStrip images={props.images} where={`from tool result ${props.name}`} />
          </div>
        </Show>
        <Show when={props.attachments && props.attachments.length > 0}>
          <div class="toolcard-section">
            <div class="toolcard-section-label">Attachments · {props.attachments!.length}</div>
            <For each={props.attachments}>
              {(a) => <PathAttachment attachment={a} where={`from tool result ${props.name}`} />}
            </For>
          </div>
        </Show>
      </div>
    </details>
  );
}
