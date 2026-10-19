/**
 * The command catalogue's types (§app.commands/catalogue), re-exported by shared/commands-catalog.ts.
 * Pure, erasable syntax only.
 */
export type CommandEffect = "looks" | "changes";
/** Where a param travels on the route. */
export type ParamIn = "body" | "query" | "path";
/**
 * A param's type. `session` is a session named by id or path (the CLI's `--session`), sent as the
 * entry's `sessionKey` says; `path` is a filesystem path the CLI resolves against its own cwd;
 * `list` is comma-separated on a command line and an array on the wire; `json` is any JSON value.
 */
export type ParamType = "string" | "number" | "integer" | "boolean" | "list" | "path" | "json" | "session";

export interface CommandParam {
  type: ParamType;
  description: string;
  in: ParamIn;
  /** The name on the wire, when it isn't the param's own (`keep-data` → `keepData`). */
  key?: string;
  required?: boolean;
  /** `null` is a value of its own (a tag list cleared). */
  nullable?: boolean;
  /** One of these, when set. */
  enum?: readonly string[];
  /** Used when the param is left out. */
  default?: string;
}

export interface CommandRoute {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** As the server registers it; `:name` segments are `in: "path"` params. */
  path: string;
  /** Body keys every call sends, whatever the params (`archived: true`, `title: null`). */
  fixed?: Readonly<Record<string, unknown>>;
}

/** A peer-listener capability, as server/mesh/access.ts names it (pinned by a test). */
export type MeshNeed = "hello" | "full" | "sessions" | "admin" | "presence" | "links" | "outreach" | "share" | "llm" | "sync.docs" | "sync.logins" | "sync.extensions";

export interface CommandEntry {
  id: string;
  label: string;
  summary: string;
  effect: CommandEffect;
  params: Readonly<Record<string, CommandParam>>;
  route: CommandRoute;
  /** How it names a session: by its file's `path`, by its `id`, or not at all. */
  sessionKey: "path" | "id" | null;
  /** `never` touches the session's file; `refuses-live` is refused while a terminal has it open; `new` makes one. */
  sessionFile: "never" | "refuses-live" | "new";
  meshNeed: MeshNeed;
}
