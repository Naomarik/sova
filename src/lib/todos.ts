import type { OverseerTodosInfo, TodoRecord } from "../../shared/protocol";

/**
 * The Overseer page's Todos panel, as data: the list split into open and done, the words for its
 * counts, and the reorder a ↑/↓ button makes. Pure, so the component only draws.
 */

/** Open todos first, then done ones, each in list order. */
export function splitTodos(info: Pick<OverseerTodosInfo, "todos"> | undefined): { open: TodoRecord[]; done: TodoRecord[] } {
  const todos = info?.todos ?? [];
  return { open: todos.filter((t) => !t.done), done: todos.filter((t) => t.done) };
}

/** Words for a count of todos: "1 todo", "3 todos". */
export const todosCount = (n: number) => `${n} ${n === 1 ? "todo" : "todos"}`;

/** The panel's meta line: "3 open · 1 done", or "No todos". */
export function todosMeta(info: Pick<OverseerTodosInfo, "open" | "done"> | undefined): string {
  if (!info) return "";
  if (!info.open && !info.done) return "No todos";
  return [`${info.open} open`, info.done ? `${info.done} done` : ""].filter(Boolean).join(" · ");
}

/**
 * The whole list's order after moving `id` one step up or down among the todos that share its
 * done state (the rows it is drawn between), or null when it is already at that end. Todos of the
 * other state keep their places, so the result is always a permutation of `todos`.
 */
export function moveId(todos: Pick<TodoRecord, "id" | "done">[], id: string, dir: -1 | 1): string[] | null {
  const at = todos.findIndex((t) => t.id === id);
  if (at < 0) return null;
  const done = todos[at]!.done;
  let to = at + dir;
  while (to >= 0 && to < todos.length && todos[to]!.done !== done) to += dir;
  if (to < 0 || to >= todos.length) return null;
  const ids = todos.map((t) => t.id);
  [ids[at], ids[to]] = [ids[to]!, ids[at]!];
  return ids;
}

/** A todo's text for an accessible name, cut so a long one doesn't drown the control's verb. */
export function todoName(text: string, max = 60): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
