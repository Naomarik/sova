/**
 * The worker host (al_3 stage 4): how the subagents extension and the hidden chats start and drive
 * worker chats. Every worker, team member and hidden chat is a chat process of its own, started by
 * the Sova server from one loadout (`WorkerSpec`) and reached only through the server; the host is
 * that server's side, announced per session on `pi.events`. Types and bus names only: nothing here
 * imports pi or touches a process. `shared/chat-runtime.ts` re-exports the loadout types for the
 * server.
 */

/** What kind of worker chat: an agent_spawn/team worker, or a hidden chat. */
export type WorkerKind = "worker" | "explain" | "handoff" | "btw";

/** A worker chat's whole loadout, as data. The parent computed it; nobody here interprets policy. */
export interface WorkerSpec {
	kind: WorkerKind;
	/** The parent chat and this worker's id in it (ag_NN; a hidden chat's own run id). */
	parent: { sessionId: string; path: string; workerId: string };
	/** The folder it runs in (a remote session's local placeholder, as today). */
	cwd: string;
	/** "provider/modelId", opened fresh; a claude-code-cli id the catalog lacks rides `flags`. */
	model: string | null;
	thinking: string | null;
	/** Built-in tools: null = pi's default set; [] = none; a list = exactly those built-ins active
	    (the rest excluded). Extension tools are never filtered (today's runner semantics). */
	builtins: string[] | null;
	/** Extensions, in load order, discovery off (`--no-extensions -e …` today): absolute files or
	    installed package dirs. */
	extensions: string[];
	/** Extension flag values (`--name value` today), registered by those extensions. */
	flags: Record<string, string | true>;
	/** Appended to the system prompt (`--append-system-prompt` today), or null. */
	appendSystemPrompt: string | null;
	/** Added to the process environment (member identity, worker tools, fork policy, Claude fork
	    point, landed file). Names must pass the env-file rule (drivers.ts envFileKeeps). */
	env: Record<string, string>;
	/** useWorktreeConfig: pi's agent dir for this chat (its process's PI_CODING_AGENT_DIR). */
	agentDir: string | null;
	/** Lower the process to the worker niceness (every kind but none today). */
	lowered: true;
}

/** How its session file comes to be, before the chat opens it. */
export type WorkerSession =
	| { new: { dir: string } } // --session-dir
	| { fork: { from: string; dir: string } } // --fork <file> (agent_spawn fork, /explain, /compact-handoff copies)
	| { resume: { file: string } } // --session <file> (agent_resume, a Claude continuation's seeded file)
	| { seed: { dir: string; messages: unknown[] } }; // /btw: the side thread's seed, written as message entries

export interface WorkerStart {
	/** Idempotent: a second start under the same key returns the first one's ref and starts nothing. */
	key: string;
	spec: WorkerSpec;
	session: WorkerSession;
	/** The first prompt; null for a resume (it comes up idle). */
	task: string | null;
}

export interface WorkerRef {
	chatId: string; // the worker session's id (the supervisor's chat id)
	sessionId: string;
	sessionFile: string;
	workerId: string;
	kind: WorkerKind;
	pid: number | null;
	state: "open" | "idle" | "ended";
}

/** Announced by Sova on each session's `pi.events`, bound to that session. */
export const WORKER_HOST_EVENT = "sova:worker-host";
/** Emit to have the host announced again (either load order is safe). */
export const WORKER_HOST_DISCOVER_EVENT = "sova:worker-host-discover";
export interface WorkerHostAnnouncement {
	version: 1;
	host: WorkerHost;
}

export interface WorkerHost {
	start(req: WorkerStart): Promise<WorkerRef>;
	send(chatId: string, input: { text: string; delivery: "prompt" | "steer" | "followUp"; key: string }): Promise<{ queued: boolean }>;
	abort(chatId: string): Promise<void>;
	stop(chatId: string, reason: string): Promise<void>;
	watch(chatId: string, cursor: WorkerCursor | null, fn: (f: WorkerFeedFrame) => void): () => void;
	/** This parent's (bound per session). */
	list(): Promise<WorkerRef[]>;
}

/** `proc`: the worker process's start id; `seq`: its feed frame's number in that process. */
export interface WorkerCursor {
	proc: string;
	seq: number;
}

export type WorkerFeedFrame =
	| { t: "state"; cursor: WorkerCursor; state: WorkerState }
	/** A wire-1 pi event (pi's rpc toJsonEvent shape), one of WORKER_FEED_EVENTS; an `agent_settled`
	    carries `settleKey`, the key its WorkerState.lastSettled will have, and `settleEntryId`, its
	    lastSettled.entryId, when known. A keyed feed (WorkerState.keys) adds `sendKey` to user messages
	    and sends `send_dropped`. */
	| { t: "event"; cursor: WorkerCursor; event: unknown }
	/** Resync: read the file, then wait for `state`. */
	| { t: "gap" }
	| {
			t: "ended";
			cause: "killed" | "done" | "died" | "reload" | "idle";
			detail?: string;
			logTail?: string[];
			resuming?: boolean;
	  };

export interface WorkerState {
	status: "starting" | "running" | "idle" | "ended";
	sessionId: string;
	sessionFile: string;
	pid: number | null;
	model: string | null;
	thinking: string | null;
	/** The last settled run: its key (`<send key>#<n>`, n counting this process's settles), the entry
	    id of its final assistant message when known, its outcome, error. */
	lastSettled: { key: string; entryId?: string; outcome: "success" | "error" | "aborted"; error?: string } | null;
	queue: { steering: string[]; followUp: string[] };
	/** Its process's feed names the send key of each user message (`sendKey` on its message_start and
	    message_end) and tells a keyed send whose message never ran (`{type: "send_dropped", sendKey}`,
	    before the settle of the run it would have joined). Absent: a worker on code from before keys
	    (or no process now): the parent correlates as it did before. */
	keys?: true;
}

/** The pi event types a worker chat feeds its parent (the set the worker fold consumes). `message_update`
    deltas are never fed. */
export const WORKER_FEED_EVENTS = [
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_end",
	"tool_execution_start",
	"tool_execution_end",
	"queue_update",
	"compaction_start",
	"compaction_end",
	"auto_retry_start",
	"auto_retry_end",
	"agent_settled",
	"extension_error",
] as const;

/** pi's built-in tools: a worker's `builtins` list keeps those it names and excludes the rest. */
export const BUILTIN_TOOLS: readonly string[] = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];

/** The `code` a WorkerHost call's error carries when nobody answered it (the server, or the worker's
    process): its outcome is unknown, and the worker is not stopped for it. */
export const NO_ANSWER = "no-answer";
/** `message` as an Error carrying NO_ANSWER. */
export const noAnswer = (message: string): Error => Object.assign(new Error(message), { code: NO_ANSWER });
export const isNoAnswer = (err: unknown): boolean => (err as { code?: unknown } | null)?.code === NO_ANSWER;

/** What a worker start or a team tool answers where no Sova server hosts the session (the pi TUI). */
export const NO_WORKER_HOST = "needs Sova's chat runtime";
