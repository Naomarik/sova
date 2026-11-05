/**
 * The background-job store: one JSON record per job a chat keeps or asks its host for, under the
 * directory `SOVA_JOBS_DIR` names (`<dir>/<session id>/<job id>.json`), so the host still knows the
 * job after the chat shut down, crashed or the host restarted. Node builtins only: the host's chat
 * runtime writes a record when it keeps a job, the host marks it ended, and wake-nudge.ts delivers
 * its end card and writes `<job id>.card` once that card (or the quiet note of a stop) is on the
 * chat's branch.
 *
 * Only a chat its host started reads here: `jobStoreOf` needs `SOVA_JOBS_DIR` and the session file
 * the host named in `SOVA_CHAT_PATH`, as the wake store does.
 */
import fs from "node:fs";
import path from "node:path";

export const JOBS_DIR_ENV = "SOVA_JOBS_DIR";
/** The directory under a state root. */
export const JOBS_DIR_NAME = "background-jobs";
/** The wake store source a job's end card is published under. */
export const JOBS_WAKE_SOURCE = "jobs";
/** At most this many running jobs per chat (a worker is a chat of its own). */
export const MAX_JOBS = 5;
/** A job still running this long after it was kept or started is stopped. */
export const JOB_TIME_LIMIT_MS = 24 * 3600_000;
/** The tag that opens a job's end card. One card can name several jobs (a machine restart). */
export const JOB_TAG_RE = /^\[job (j\d+(?:,j\d+)*)\]/;

export type JobEndHow = "exited" | "stopped" | "time-limit" | "restart" | "archived" | "worker-stopped";
/** What the chat gets: a card that wakes it, a quiet note on its next run, or nothing. */
export type JobCard = "wake" | "note" | "none";

export interface JobRecord {
	v: 1;
	/** `j1`, unique within its chat. */
	id: string;
	sessionId: string;
	/** The chat's session file. */
	path: string;
	/** Kept: what a command left running. Requested: started by the host on the chat's request (it has an exit code). */
	kind: "kept" | "requested";
	/** What ran (the command, as the model wrote it). */
	command: string;
	cwd: string;
	/** The unit it runs in (`….scope`, `….service`), or the detached driver's unit name. */
	unit: string;
	driver: "systemd" | "detached";
	/** Its cgroup directory (systemd): the job is alive while it holds a process. */
	cgroup?: string;
	startedAt: number;
	/** The machine's boot it started in: a later boot means a restart or logout ended it. */
	bootId: string;
	/** Where its output goes, when it goes to a file. */
	output?: string;
	/** Its output goes only to its command's closed output: it dies the first time it writes. */
	noOutput?: true;
	/** A requested job's wrapper writes its exit code here. */
	exitFile?: string;
	/** A requested job's own sandbox tmp (`<sandbox tmp base>/<id>`), removed at its end. */
	scratch?: string;
	/** The worker id, when a worker's (shown on its row in the main chat's pane). */
	worker?: string;
	/** Someone asked for it to stop: what the end is put down to. */
	stop?: { at: number; why: "stop" | "archive" | "worker" | "teardown" };
	ended?: { at: number; how: JobEndHow; exit?: number | null; card: JobCard; late?: number };
}

export interface JobStore {
	dir: string;
	sessionId: string;
	path: string;
}

const enc = encodeURIComponent;
export const sessionJobsDir = (dir: string, sessionId: string) => path.join(dir, enc(sessionId));
export const jobFile = (dir: string, sessionId: string, id: string) => path.join(sessionJobsDir(dir, sessionId), `${id}.json`);
export const cardFile = (dir: string, sessionId: string, id: string) => path.join(sessionJobsDir(dir, sessionId), `${id}.card`);

/** This chat's job store, or none: only the chat its host started, on the session file it was started for. */
export function jobStoreOf(sessionId: string | undefined, sessionFile: string | undefined, env: NodeJS.ProcessEnv = process.env): JobStore | undefined {
	const dir = env[JOBS_DIR_ENV];
	const hosted = env.SOVA_CHAT_PATH;
	if (!dir || !hosted || !sessionId || !sessionFile || path.resolve(hosted) !== path.resolve(sessionFile)) return undefined;
	return { dir, sessionId, path: sessionFile };
}

function writeAtomic(file: string, text: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	fs.writeFileSync(tmp, text, { mode: 0o600 });
	fs.renameSync(tmp, file);
}

export function writeJob(dir: string, r: JobRecord): void {
	writeAtomic(jobFile(dir, r.sessionId, r.id), `${JSON.stringify(r)}\n`);
}

function parseJob(text: string): JobRecord | null {
	try {
		const r = JSON.parse(text) as Partial<JobRecord>;
		if (r?.v !== 1 || typeof r.id !== "string" || typeof r.sessionId !== "string" || typeof r.unit !== "string" || typeof r.startedAt !== "number") return null;
		return r as JobRecord;
	} catch {
		return null;
	}
}

export function readJob(dir: string, sessionId: string, id: string): JobRecord | null {
	try {
		return parseJob(fs.readFileSync(jobFile(dir, sessionId, id), "utf8"));
	} catch {
		return null;
	}
}

/** A chat's jobs, oldest first. A file that doesn't read as one is left out. */
export function readSessionJobs(dir: string, sessionId: string): JobRecord[] {
	let names: string[];
	try {
		names = fs.readdirSync(sessionJobsDir(dir, sessionId));
	} catch {
		return [];
	}
	const out: JobRecord[] = [];
	for (const name of names) {
		if (!/^j\d+\.json$/.test(name)) continue;
		try {
			const r = parseJob(fs.readFileSync(path.join(sessionJobsDir(dir, sessionId), name), "utf8"));
			if (r) out.push(r);
		} catch {
			/* Half-written or gone. */
		}
	}
	return out.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
}

/** Every job of every chat. */
export function readAllJobs(dir: string): JobRecord[] {
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return [];
	}
	return names.flatMap((n) => {
		try {
			return readSessionJobs(dir, decodeURIComponent(n));
		} catch {
			return [];
		}
	});
}

/** The next job id of a chat: past every record it has, ended ones included. */
export function nextJobId(dir: string, sessionId: string): string {
	let max = 0;
	try {
		for (const name of fs.readdirSync(sessionJobsDir(dir, sessionId))) {
			const m = /^j(\d+)\./.exec(name);
			if (m && Number(m[1]) > max) max = Number(m[1]);
		}
	} catch {
		/* none yet */
	}
	return `j${max + 1}`;
}

export const runningJobs = (jobs: JobRecord[]) => jobs.filter((j) => !j.ended);

/** Whether the chat already has this job's card (or note) on its branch. */
export const cardDone = (dir: string, sessionId: string, id: string) => fs.existsSync(cardFile(dir, sessionId, id));

/** Record that this job's card or note is on the branch (or was left unsent past the wake limit). */
export function markCardDone(dir: string, sessionId: string, id: string, what: "sent" | "noted" | "skipped"): void {
	writeAtomic(cardFile(dir, sessionId, id), `${what}\n`);
}

/** The ended jobs whose card or note the chat still owes itself. */
export function pendingCards(dir: string, sessionId: string): JobRecord[] {
	return readSessionJobs(dir, sessionId).filter((j) => j.ended && j.ended.card !== "none" && !cardDone(dir, sessionId, j.id));
}

/** Remove a chat's whole job directory (its chat was deleted, and its jobs are stopped). */
export function dropSessionJobs(dir: string, sessionId: string): void {
	fs.rmSync(sessionJobsDir(dir, sessionId), { recursive: true, force: true });
}

export function fmtDur(ms: number): string {
	let s = Math.max(0, Math.round(ms / 1000));
	const h = Math.floor(s / 3600);
	s -= h * 3600;
	const m = Math.floor(s / 60);
	s -= m * 60;
	if (h) return m ? `${h}h${m}m` : `${h}h`;
	if (m) return s ? `${m}m${s}s` : `${m}m`;
	return `${s}s`;
}

export const NO_OUTPUT_LINE = "This job has no output file and will die the first time it writes.";
export const overLimitLine = (n: number) => `This command left something running, but this chat already keeps ${n} background jobs, so it wasn't kept. It will end at this chat's next shutdown or reload.`;
export const OVER_LIMIT_LINE = overLimitLine(MAX_JOBS);
/** The limit, which a test host may lower (\`SOVA_JOBS_MAX\`). */
export const maxJobs = (env: NodeJS.ProcessEnv = process.env) => (Number(env.SOVA_JOBS_MAX) > 0 ? Math.floor(Number(env.SOVA_JOBS_MAX)) : MAX_JOBS);
const oneLine = (s: string, max = 200) => {
	const t = s.replace(/\s+/g, " ").trim();
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

function howLine(j: JobRecord): string {
	const e = j.ended!;
	if (e.how === "time-limit") return "It hit the time limit of 24 hours and was stopped.";
	if (e.how === "restart") return "The machine restarted or you logged out, which ended it. Sova does not start it again.";
	if (e.how === "stopped") return "It was stopped.";
	if (j.kind === "requested") return e.exit === 0 ? "It passed (exit code 0)." : typeof e.exit === "number" ? `It failed (exit code ${e.exit}).` : "It ended without an exit code.";
	return "It ended on its own; its output says whether it worked.";
}

/** One job's lines in a card: what ran, how long, where its output is, how it ended. */
function jobLines(j: JobRecord): string[] {
	const e = j.ended!;
	return [
		`${j.id}: \`${oneLine(j.command)}\`${j.worker ? ` (worker ${j.worker})` : ""}, ran ${fmtDur(e.at - j.startedAt)}.`,
		j.noOutput ? NO_OUTPUT_LINE : j.output ? `Output: ${j.output}` : "Output: none recorded.",
		howLine(j),
		// When it ended, not when the card arrives: the card's "ended HH:MM" (shared/wake.ts parses it).
		`Ended at ${new Date(e.at).toISOString()}.`,
	];
}

/**
 * The end card's text: `[job j1] …` for one job, `[job j1,j2] …` for every job a machine restart
 * ended. `late` is how long after the end it is delivered when Sova wasn't running; `limitHit` is the
 * 30th wake without the user.
 */
export function jobCardText(jobs: JobRecord[], o: { late?: number; limitHit?: boolean; limit?: number }): string {
	const ids = jobs.map((j) => j.id).join(",");
	const lines = [jobs.length > 1 ? `[job ${ids}] ${jobs.length} background jobs ended.` : `[job ${ids}] Background job ended.`];
	if (o.late && o.late > 60_000) lines.push(`Late by ${fmtDur(o.late)} (Sova was not running).`);
	for (const j of jobs) lines.push(...jobLines(j));
	lines.push(
		o.limitHit
			? `Wake limit (${o.limit ?? 30}) reached without user input: do not start more background jobs or nudges; summarize status and wait for the user.`
			: "Read its output and decide what to do next. Prioritize any newer user message.",
	);
	return lines.join("\n");
}

/** The quiet note of a job stopped from Sova (no wake): the chat reads it on its next run. */
export function jobStoppedNote(j: JobRecord): string {
	const e = j.ended!;
	return `[job ${j.id} stopped] Background job ${j.id} (\`${oneLine(j.command)}\`) was stopped from Sova after it ran ${fmtDur(e.at - j.startedAt)}.${j.output ? ` Its output: ${j.output}` : ""}`;
}
