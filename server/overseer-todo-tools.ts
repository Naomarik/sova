import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SessionSummary, SovaTodoDetails, TodoPatch, TodoRecord } from "../shared/protocol";
import type { ToolCall } from "./overseer-idea-tools";
import { addTodo, clearDone, readTodos, removeTodo, TodoError, updateTodo } from "./overseer-todos";

/**
 * The Overseer's todos tools: `sova_todos` reads the user's checklist (allowed in every turn) and
 * `sova_todo` changes it (an act: audited, and refused in a turn the user did not start, ticking
 * included: a worker's report is never the user's word that their task is done). Two tools, so
 * each one's class is structural rather than an `if` on its op.
 */

type Out = { content: { type: "text"; text: string }[]; details: unknown };
type Tool = ToolDefinition<any, any>;

export interface TodoToolDeps {
  act(name: string, run: (params: any, toolCallId: string, call: ToolCall) => Promise<Out>): Tool["execute"];
  read(run: (params: any, call: ToolCall & { toolCallId: string }) => Promise<Out>): Tool["execute"];
  /** Any session by id: a todo only points at it, so TUI-live and archived sessions are fine. */
  resolve(ref: unknown): Promise<SessionSummary>;
  /** A refusal the model relays (logged "refused"). */
  refusal(message: string): Error;
  obj(properties: Record<string, unknown>, required?: string[]): any;
  str(description: string, extra?: Record<string, unknown>): unknown;
}

const text = (t: string) => [{ type: "text" as const, text: t }];

/** One todo as a listing row: `- [ ] td_ab12cd34 · Revoke GitLab token · §idea · session sova://s/<id>`. */
export function todoRow(t: TodoRecord): string {
  const extra = [t.ideaId ?? "", t.sessionId ? `session sova://s/${t.sessionId}` : ""].filter(Boolean);
  return `- [${t.done ? "x" : " "}] ${t.id} · ${t.text}${extra.length ? ` · ${extra.join(" · ")}` : ""}`;
}

const openOf = () => readTodos().todos.filter((t) => !t.done).length;
const openWords = () => `${openOf()} open`;

export function todoTools(d: TodoToolDeps): Tool[] {
  const { obj, str } = d;
  /** Store refusals become tool refusals. */
  const guard = async <T>(f: () => T | Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (err) {
      if (err instanceof TodoError) throw d.refusal(err.message);
      throw err;
    }
  };
  const need = (id: unknown): TodoRecord => {
    const t = typeof id === "string" ? readTodos().todos.find((x) => x.id === id.trim()) : undefined;
    if (!t) throw new TodoError(`No todo ${String(id ?? "")}. sova_todos lists them with their ids.`);
    return t;
  };
  /** The session link as stored: "" unlinks; anything else must be a session that exists. */
  const sessionOf = async (ref: unknown): Promise<string> => (ref === "" ? "" : (await d.resolve(ref)).id);
  const details = (id: string, op: SovaTodoDetails["op"], extra: Partial<SovaTodoDetails> = {}): SovaTodoDetails => ({ id, op, ...extra });

  return [
    {
      name: "sova_todos",
      label: "Todos",
      description:
        "Read the user's todos: their short checklist of small tasks for themselves, in their order. status open (default), done or all. Each row has the todo's id (td_…) for sova_todo, and the idea or session it is about.",
      promptSnippet: "read the user's todos checklist (open, done or all), with ids",
      parameters: obj({ status: str("open | done | all (default open)", { enum: ["open", "done", "all"] }) }),
      execute: d.read(async (p) =>
        guard(async () => {
          const { todos } = readTodos();
          const done = todos.filter((t) => t.done).length;
          const status = p.status === "done" || p.status === "all" ? p.status : "open";
          const shown = todos.filter((t) => status === "all" || t.done === (status === "done"));
          const head = `${todos.length - done} open, ${done} done.`;
          const body = shown.length ? shown.map(todoRow).join("\n") : todos.length ? `No ${status} todos.` : "The list is empty.";
          return { content: text(`${head}\n${body}`), details: { open: todos.length - done, done, ids: shown.map((t) => t.id) } };
        }),
      ),
    },
    {
      name: "sova_todo",
      label: "Todo",
      description:
        "Change the user's todos (only in a turn the user started). op add: a new todo at the end (text; idea, session optional). check / uncheck: tick or untick one, only on the user's word. edit: new text, or link or unlink an idea or session. remove: delete one, only when the user asks. clear_done: delete every ticked todo.",
      promptSnippet: "change the user's todos: add, check, uncheck, edit, remove, clear_done",
      parameters: obj(
        {
          op: str("add | check | uncheck | edit | remove | clear_done", { enum: ["add", "check", "uncheck", "edit", "remove", "clear_done"] }),
          id: str("The todo's id from sova_todos (check, uncheck, edit, remove)."),
          text: str(`add: the task, one line, at most 200 characters, in the user's words. edit: the new text.`),
          idea: str('add, edit: the § id of the idea this task belongs to (must exist), or "" to unlink.'),
          session: str('add, edit: the id of the session this task is about, or "" to unlink.'),
        },
        ["op"],
      ),
      execute: d.act("sova_todo", async (p) =>
        guard(async () => {
          switch (p.op) {
            case "add": {
              const t = addTodo({ text: p.text, ideaId: p.idea, sessionId: p.session === undefined ? undefined : await sessionOf(p.session) });
              return { content: text(`Added ${t.id}: ${t.text} (${openWords()}).`), details: details(t.id, "add", { done: false }) };
            }
            case "check":
            case "uncheck": {
              const cur = need(p.id);
              const want = p.op === "check";
              if (cur.done === want)
                return { content: text(`${cur.id} was already ${want ? "done" : "open"}: ${cur.text}. Nothing changed.`), details: details(cur.id, p.op, { done: cur.done }) };
              const t = updateTodo(cur.id, { done: want });
              return { content: text(`${want ? "Ticked" : "Unticked"} ${t.id}: ${t.text} (${openWords()}).`), details: details(t.id, p.op, { done: t.done }) };
            }
            case "edit": {
              const cur = need(p.id);
              const patch: TodoPatch = {};
              if (p.text !== undefined) patch.text = p.text;
              if (p.idea !== undefined) patch.ideaId = p.idea;
              if (p.session !== undefined) patch.sessionId = await sessionOf(p.session);
              if (!Object.keys(patch).length) throw new TodoError("edit needs text, idea or session.");
              const t = updateTodo(cur.id, patch);
              const links = [t.ideaId ?? "", t.sessionId ? `session sova://s/${t.sessionId}` : ""].filter(Boolean);
              return { content: text(`Edited ${t.id}: ${t.text}${links.length ? ` (${links.join(", ")})` : ""}.`), details: details(t.id, "edit", { done: t.done }) };
            }
            case "remove": {
              const t = removeTodo(need(p.id).id);
              return { content: text(`Removed ${t.id}: ${t.text} (${openWords()}).`), details: details(t.id, "remove") };
            }
            case "clear_done": {
              const removed = clearDone();
              return {
                content: text(removed ? `Cleared ${removed} done ${removed === 1 ? "todo" : "todos"} (${openWords()}).` : "No done todos to clear."),
                details: details("", "clear_done", { removed }),
              };
            }
            default:
              throw new TodoError("op must be add, check, uncheck, edit, remove or clear_done.");
          }
        }),
      ),
    },
  ];
}
