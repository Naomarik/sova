/**
 * Offline tests for /explain. No model requests and no real pi process: the
 * child is a fake RPC process injected through the runner's spawnImpl seam, and
 * every store is a temp directory. Run with:
 *
 *   node --test index.test.ts
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ChildProcess } from "node:child_process";
import { ExplainRuns, MAX_LIVE, failureWakeText, oneLineError, wakeMessage, wakeText, type ExplainHost } from "./explain.ts";
import { parentIdentity } from "./identity.ts";
import { buildChildPrompt, bylineText } from "./prompt.ts";
import {
	EXPLAIN_ENTRY_TYPE,
	agentDir,
	dropOrphanMeta,
	entryData,
	explanationsRoot,
	isExplanationId,
	newId,
	normalizeMeta,
	oneParagraph,
	runningEntryData,
	pageWarnings,
	scanExternalRefs,
	slugify,
	storeDir,
	validateStore,
	writeMeta,
	type ExplainEntryData,
	type KnownMeta,
} from "./store.ts";
import { EXPLAIN_TOOLS, WORKER_MARK_EXTENSION, forkable, startExplainWorker, webAccessExtension } from "./worker.ts";

function tmp(prefix = "explain-test-"): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

const PAGE = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<style>:root{--fg:#111}@media (prefers-color-scheme: dark){:root{--fg:#eee}}</style>
<script>document.documentElement.dataset.theme=new URLSearchParams(location.search).get("theme")||"auto"</script>
</head><body><h1>t</h1><p class="byline">Explained by zai/glm-5.3 · Sep 20, 2026</p><svg viewBox="0 0 10 10"></svg><pre>x</pre></body></html>`;

function known(overrides: Partial<KnownMeta> = {}): KnownMeta {
	return {
		id: "topic-abc",
		topic: "vector clocks",
		parentSessionId: "sess-1",
		cwd: "/repo",
		createdAt: "2026-09-20T10:00:00.000Z",
		model: "zai/glm-5.3",
		...overrides,
	};
}

// ── store contract ─────────────────────────────────────────────────────────

test("ids are directory- and URL-safe, readable, and unique per run", () => {
	assert.equal(slugify("CRDTs: how do they *merge*?"), "crdts-how-do-they-merge");
	assert.equal(slugify("   "), "explanation");
	assert.equal(slugify("a".repeat(200)).length, 48);
	const id = newId("Vector clocks", 1_758_362_400_000);
	assert.match(id, /^vector-clocks-[0-9a-z]+$/);
	assert.ok(isExplanationId(id));
	assert.equal(isExplanationId("../escape"), false);
	assert.equal(isExplanationId(""), false);
	assert.equal(newId("x", 1000, (candidate) => candidate === "x-rs"), "x-rs-2");
	assert.throws(() => storeDir("../escape"), /Invalid explanation id/);
});

test("the store root follows the agent directory, not a hardcoded home", () => {
	assert.equal(agentDir({ PI_AGENT_DIR: "/custom/agent" } as NodeJS.ProcessEnv), "/custom/agent");
	assert.equal(agentDir({ PI_CODING_AGENT_DIR: "/legacy" } as NodeJS.ProcessEnv), "/legacy");
	assert.equal(explanationsRoot({ PI_AGENT_DIR: "/custom/agent" } as NodeJS.ProcessEnv), "/custom/agent/explanations");
	assert.equal(storeDir("abc", { PI_AGENT_DIR: "/custom/agent" } as NodeJS.ProcessEnv), "/custom/agent/explanations/abc");
});

test("summaries are one paragraph and the parent owns every other meta field", () => {
	assert.equal(oneParagraph("- **It is**\n  a queue\n\nwith clocks."), "It is** a queue with clocks.");
	assert.equal(oneParagraph(42), "");
	assert.equal(oneParagraph("x".repeat(20), 10).length, 10);
	const meta = normalizeMeta({ summary: "A retry queue with a vector clock.", id: "hacked", cwd: "/elsewhere", extra: 1 }, known());
	assert.deepEqual(meta, { ...known(), summary: "A retry queue with a vector clock." });
	assert.deepEqual(Object.keys(meta).sort(), ["createdAt", "cwd", "id", "model", "parentSessionId", "summary", "topic"]);
});

test("validateStore fails without a page, repairs meta.json, and reports contract slips", () => {
	const dir = tmp();
	try {
		assert.equal(validateStore(dir, known()).ok, false);
		writeFileSync(join(dir, "index.html"), "");
		assert.match(validateStore(dir, known()).error!, /empty or not a file/);

		// Child wrote the page but forgot meta.json: repaired, still usable.
		writeFileSync(join(dir, "index.html"), PAGE);
		const repaired = validateStore(dir, known());
		assert.equal(repaired.ok, true);
		assert.deepEqual(JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")), { ...known(), summary: "" });
		assert.ok(repaired.warnings.some((w) => /meta.json was missing/.test(w)));

		// Child wrote meta.json with its own idea of the id: the parent's values win.
		writeFileSync(join(dir, "meta.json"), JSON.stringify({ id: "nope", summary: "One paragraph." }));
		const fixed = validateStore(dir, known());
		assert.equal(fixed.meta!.summary, "One paragraph.");
		assert.equal(fixed.meta!.id, "topic-abc");
		assert.deepEqual(JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")), fixed.meta);
		assert.deepEqual(fixed.warnings, []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a page that phones home or ignores small screens is flagged, not lost", () => {
	const dir = tmp();
	try {
		writeFileSync(join(dir, "index.html"), `<!doctype html><html><head><link href="https://cdn.example/x.css"><style>@import "//fonts.example/f.css"</style></head><body><img src="data:image/png;base64,AA"><svg></svg></body></html>`);
		writeFileSync(join(dir, "meta.json"), JSON.stringify({ ...known(), summary: "s" }));
		const check = validateStore(dir, known());
		assert.equal(check.ok, true);
		assert.ok(check.warnings.some((w) => w.includes("external requests")));
		assert.ok(check.warnings.includes("no viewport meta tag"));
		assert.ok(check.warnings.includes("no ?theme= handling"));
		assert.ok(check.warnings.some((w) => w.includes("prefers-color-scheme fallback")));
		assert.ok(check.warnings.includes("an SVG without viewBox"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	assert.deepEqual(scanExternalRefs(`<img src="data:image/png;base64,AA"><a href="#top">`), []);
	assert.deepEqual(scanExternalRefs(`<script src="http://x/y.js">`), ["http://x/y.js"]);
	// A citation link fetches nothing until it is clicked; only subresources count.
	assert.deepEqual(scanExternalRefs(`<p>see <a href="https://www.rfc-editor.org/rfc/rfc6298">RFC 6298</a></p>`), []);
	assert.deepEqual(scanExternalRefs(`<link rel="stylesheet" href="https://cdn/x.css">`), ["https://cdn/x.css"]);
	assert.deepEqual(scanExternalRefs(`<svg><use href="https://cdn/sprite.svg#x"/></svg>`), ["https://cdn/sprite.svg#x"]);
	assert.deepEqual(scanExternalRefs(`<img srcset="//cdn/x.png 2x">`), ["//cdn/x.png"]);
});

test("a page that only works with JavaScript is flagged: the gallery thumbnail is sandboxed", () => {
	const scriptOnly = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<script>applyTheme(new URLSearchParams(location.search))</script></head><body></body></html>`;
	const warnings = pageWarnings(scriptOnly);
	assert.ok(warnings.some((w) => w.includes("prefers-color-scheme fallback")), "no CSS fallback means a sandboxed iframe renders the wrong theme");
	assert.equal(warnings.some((w) => /^\d+ scripts/.test(w)), false, "one theme script is the contract, not a warning");

	const scripted = `${scriptOnly.replace("</body>", '<script src="./app.js"></script><script>render()</script></body>')}`;
	assert.ok(pageWarnings(scripted).some((w) => w.includes("3 scripts")), "extra scripts silently do nothing in the thumbnail");
	assert.deepEqual(pageWarnings(PAGE), [], "a page built to the contract warns about nothing");
});

test("entryData is the exact envelope, with error only on failure", () => {
	const meta = { ...known(), summary: "One paragraph." };
	assert.deepEqual(entryData(meta), {
		id: "topic-abc",
		topic: "vector clocks",
		summary: "One paragraph.",
		createdAt: "2026-09-20T10:00:00.000Z",
		parentSessionId: "sess-1",
		model: "zai/glm-5.3",
	});
	assert.deepEqual(entryData(meta, { kind: "error", text: "no page" }), { ...entryData(meta), error: "no page" });
	assert.deepEqual(entryData(meta, { kind: "note", text: "died after writing" }), { ...entryData(meta), note: "died after writing" });
	assert.equal("note" in entryData(meta, { kind: "error", text: "no page" }), false, "never both");
	assert.equal("error" in entryData(meta, { kind: "note", text: "x" }), false, "never both");
	assert.deepEqual(Object.keys(entryData(meta)), ["id", "topic", "summary", "createdAt", "parentSessionId", "model"], "a clean run carries neither");
	assert.equal("model" in entryData({ ...meta, model: "" }), false, "an unknown model is absent, never an empty string");
	assert.equal(EXPLAIN_ENTRY_TYPE, "explain-doc");
	assert.equal("status" in entryData(meta), false, "a final entry never carries status");
	assert.equal("status" in entryData(meta, { kind: "error", text: "x" }), false);
});

test("runningEntryData is the provisional envelope: known fields, empty summary, status running", () => {
	assert.deepEqual(runningEntryData(known()), {
		id: "topic-abc",
		topic: "vector clocks",
		summary: "",
		createdAt: "2026-09-20T10:00:00.000Z",
		parentSessionId: "sess-1",
		model: "zai/glm-5.3",
		status: "running",
	});
	assert.equal("model" in runningEntryData(known({ model: "" })), false, "an unknown model is absent here too");
	const data = runningEntryData(known());
	assert.equal("error" in data || "note" in data, false);
});

// ── child prompt ───────────────────────────────────────────────────────────

test("the child prompt carries the store contract, the audience, and the no-browser rule", () => {
	const spec = { ...known(), dir: "/store/topic-abc", indexPath: "/store/topic-abc/index.html", metaPath: "/store/topic-abc/meta.json", webSearch: true, forked: true };
	const prompt = buildChildPrompt(spec);
	assert.ok(prompt.includes("Explain this: **vector clocks**"));
	assert.ok(prompt.includes("/store/topic-abc/index.html") && prompt.includes("/store/topic-abc/meta.json"));
	for (const field of ["id", "topic", "summary", "parentSessionId", "cwd", "createdAt", "model"]) {
		assert.ok(prompt.includes(`"${field}"`), `meta field ${field} is specified`);
	}
	assert.ok(prompt.includes('"sess-1"') && prompt.includes('"zai/glm-5.3"'), "the parent's values are given verbatim");
	assert.ok(prompt.includes("3–5 sentences: what the page covers and its sharpest takeaway"));
	assert.ok(prompt.includes("clamped to three\nlines in the gallery card"), "the length bound is justified by where it renders");
	assert.ok(prompt.includes("zero external requests"));
	assert.ok(prompt.includes("width=device-width"));
	assert.ok(prompt.includes("before first\npaint") || prompt.includes("before first"));
	assert.ok(prompt.includes("?theme=dark"));
	assert.ok(prompt.includes('iframe sandbox=""') && prompt.includes("work completely with scripts disabled"), "the sandboxed thumbnail constraint reaches the child");
	assert.ok(prompt.includes("prefers-color-scheme: dark"));
	assert.ok(prompt.includes('name="color-scheme" content="dark light"'), "the page opts into the embedder's colour scheme without a script");
	assert.ok(prompt.includes("viewBox") && prompt.includes("overflow-x: auto"));
	assert.ok(/Never open a browser/.test(prompt) && prompt.includes("open-html.sh"));
	assert.ok(prompt.includes("No 101."), "audience rules are adapted, not summarized");
	assert.ok(prompt.includes("this conversation's full history"));
	assert.ok(prompt.includes("search the web"));

	const fresh = buildChildPrompt({ ...spec, webSearch: false, forked: false });
	assert.ok(fresh.includes("starting fresh"));
	assert.ok(fresh.includes("no web access"));
});

test("the byline is injected as a literal, under the title, for the cropped thumbnail", () => {
	assert.equal(bylineText("zai/glm-5.3", "2026-09-20T10:00:00.000Z"), "Explained by zai/glm-5.3 · Sep 20, 2026");
	assert.equal(bylineText("", "2026-09-20T10:00:00.000Z"), "Explained by an unnamed model · Sep 20, 2026");
	assert.equal(bylineText("m", "not-a-date"), "Explained by m · not-a-date", "a bad timestamp is passed through, never rendered as Invalid Date");

	const prompt = buildChildPrompt({ ...known(), dir: "/d", indexPath: "/d/index.html", metaPath: "/d/meta.json", webSearch: false, forked: false });
	assert.ok(prompt.includes("Explained by zai/glm-5.3 · Sep 20, 2026"), "the child stamps literals, it does not guess its model or the date");
	assert.ok(prompt.includes("directly under the page's `<h1>`"));
	assert.ok(prompt.includes("not a\n  footer"), "the byline sits in the header flow, where a reader of the full page sees it");
	assert.ok(prompt.includes("first ~200px of the document"), "no hero band can push the title out of the thumbnail's top");

	assert.ok(pageWarnings(`<html><h1>t</h1><p>no byline</p></html>`).includes("no model byline under the title"));
	assert.equal(pageWarnings(PAGE).includes("no model byline under the title"), false);
});

// ── run lifecycle ──────────────────────────────────────────────────────────

interface Recorded {
	entries: { type: string; data: ExplainEntryData }[];
	notes: { message: string; level: string }[];
	wakes: string[];
	started: { spec: any; settle: (result: any) => void; killed: boolean }[];
}

function harness(env: NodeJS.ProcessEnv): { runs: ExplainRuns; rec: Recorded } {
	const rec: Recorded = { entries: [], notes: [], wakes: [], started: [] };
	const host: ExplainHost = {
		env,
		now: () => Date.parse("2026-09-20T10:00:00.000Z"),
		appendEntry: (data) => rec.entries.push({ type: EXPLAIN_ENTRY_TYPE, data }),
		notify: (message, level) => rec.notes.push({ message, level }),
		wake: (text) => rec.wakes.push(text),
		start: (spec, handlers) => {
			const entry = { spec, settle: handlers.onSettled, killed: false };
			rec.started.push(entry);
			return { kill: async () => { entry.killed = true; } };
		},
	};
	return { runs: new ExplainRuns(host), rec };
}

test("begin creates the store, forks a persisted parent, and rejects an empty topic", () => {
	const root = tmp();
	const env = { PI_AGENT_DIR: root } as NodeJS.ProcessEnv;
	const sessionFile = join(root, "parent.jsonl");
	writeFileSync(sessionFile, '{"type":"session","id":"sess-1"}\n{"type":"message","message":{"role":"user"}}\n');
	const { runs, rec } = harness(env);
	try {
		assert.throws(() => runs.begin({ topic: "   ", cwd: "/repo", parentSessionId: "sess-1", model: "zai/glm-5.3" }), /Nothing to explain/);

		const started = runs.begin({ topic: "  vector   clocks ", cwd: "/repo", parentSessionId: "sess-1", parentSessionFile: sessionFile, model: "zai/glm-5.3" });
		assert.equal(started.forked, true);
		assert.equal(started.dir, join(root, "explanations", started.id));
		assert.ok(existsSync(started.dir), "the child gets a directory it can write into");
		assert.equal(rec.started[0].spec.forkSession, sessionFile);
		assert.equal(rec.started[0].spec.cwd, "/repo");
		assert.ok(rec.started[0].spec.task.includes(started.dir));
		assert.ok(rec.started[0].spec.task.includes("vector clocks"), "whitespace in the topic is collapsed");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an unpersisted parent session still explains, unforked", () => {
	const root = tmp();
	const env = { PI_AGENT_DIR: root } as NodeJS.ProcessEnv;
	const { runs, rec } = harness(env);
	try {
		const missing = runs.begin({ topic: "monads", cwd: "/repo", parentSessionId: "sess-1", parentSessionFile: join(root, "not-written-yet.jsonl"), model: "m" });
		assert.equal(missing.forked, false);
		assert.equal("forkSession" in rec.started[0].spec, false);
		assert.ok(rec.started[0].spec.task.includes("starting fresh"));

		writeFileSync(join(root, "empty.jsonl"), "");
		assert.equal(forkable(join(root, "empty.jsonl")), false, "an empty file is not a forkable session");
		assert.equal(forkable(undefined), false);
		assert.equal(forkable(join(root, "never-written.jsonl")), false, "a missing file is not forkable");
		assert.equal(forkable(root), false, "a directory is not forkable");

		// A brand-new session whose first input is /explain: pi wrote only the header.
		const header = join(root, "header-only.jsonl");
		writeFileSync(header, '{"type":"session","version":3,"id":"sess-1","cwd":"/repo"}\n');
		assert.equal(forkable(header), false, "a header-only file would fork an EMPTY conversation");
		const headerRun = runs.begin({ topic: "raft", cwd: "/repo", parentSessionId: "sess-1", parentSessionFile: header, model: "m" });
		assert.equal(headerRun.forked, false, "the UI must not claim a fork of nothing");
		assert.equal("forkSession" in rec.started[1].spec, false);

		writeFileSync(header, '{"type":"session","version":3,"id":"sess-1","cwd":"/repo"}\n{"type":"message","id":"a","message":{"role":"user","content":"hi"}}\n');
		assert.equal(forkable(header), true, "one real message makes it forkable");

		// The hit sits past the first read chunk and straddles a chunk boundary.
		const big = join(root, "big.jsonl");
		const mark = '"type":"message"';
		const pad = 64 * 1024 - 5;
		writeFileSync(big, `${"x".repeat(pad)}${mark}\n`);
		assert.equal(forkable(big), true, "a mark split across two reads is still found");
		writeFileSync(big, `${'{"type":"custom"}\n'.repeat(10_000)}`);
		assert.equal(forkable(big), false, "custom entries alone are not a conversation");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a spawned child records a running entry; once settled and validated, the final entry supersedes it", () => {
	const root = tmp();
	const env = { PI_AGENT_DIR: root } as NodeJS.ProcessEnv;
	const { runs, rec } = harness(env);
	try {
		const started = runs.begin({ topic: "vector clocks", cwd: "/repo", parentSessionId: "sess-1", model: "zai/glm-5.3" });
		writeFileSync(join(started.dir, "index.html"), PAGE);
		writeFileSync(join(started.dir, "meta.json"), JSON.stringify({ id: started.id, summary: "It is a retry queue with a vector clock." }));

		assert.equal(rec.entries.length, 1, "the running entry lands as soon as the child is spawned");
		assert.deepEqual(rec.entries[0].data, runningEntryData({ ...known(), id: started.id }));

		rec.started[0].settle({ outcome: "success", finalOutput: "wrote the page", model: "zai/glm-5.4" });

		assert.equal(rec.entries.length, 2);
		assert.equal(rec.entries[1].type, "explain-doc");
		assert.equal(rec.entries[1].data.id, rec.entries[0].data.id, "the final entry supersedes the running one by id");
		assert.equal("status" in rec.entries[1].data, false, "the final entry carries no status");
		assert.deepEqual(rec.entries[1].data, {
			id: started.id,
			topic: "vector clocks",
			summary: "It is a retry queue with a vector clock.",
			createdAt: "2026-09-20T10:00:00.000Z",
			parentSessionId: "sess-1",
			model: "zai/glm-5.4",
		});
		assert.equal("error" in rec.entries[1].data, false);
		assert.equal(JSON.parse(readFileSync(join(started.dir, "meta.json"), "utf8")).model, "zai/glm-5.4", "the model the child actually ran on is recorded");
		assert.equal(rec.wakes.length, 1);
		assert.ok(rec.wakes[0].includes(`${started.dir}/index.html`));
		assert.ok(rec.wakes[0].includes("viewable in pi-web"));
		assert.equal(rec.started[0].killed, true, "the child is stopped once its work is recorded");
		assert.equal(runs.live, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a failed child and a child that wrote nothing both record a failure entry", () => {
	const root = tmp();
	const env = { PI_AGENT_DIR: root } as NodeJS.ProcessEnv;
	const { runs, rec } = harness(env);
	try {
		const failed = runs.begin({ topic: "consensus", cwd: "/repo", parentSessionId: "sess-1", model: "m" });
		rec.started[0].settle({ outcome: "error", error: "provider rejected the request", finalOutput: "" });
		assert.equal(rec.entries[0].data.status, "running");
		assert.equal(rec.entries[1].data.id, failed.id);
		assert.equal("status" in rec.entries[1].data, false, "a failed entry is final too");
		assert.match(rec.entries[1].data.error!, /worker error; provider rejected the request/);
		assert.equal(rec.entries[1].data.summary, "");
		assert.ok(rec.wakes[0].includes("failed"));
		assert.equal(rec.notes.at(-1)!.level, "warning");

		const silent = runs.begin({ topic: "paxos", cwd: "/repo", parentSessionId: "sess-1", model: "m" });
		rec.started[1].settle({ outcome: "success", finalOutput: "I decided not to write it." });
		assert.equal(rec.entries[3].data.id, silent.id);
		assert.match(rec.entries[3].data.error!, /no index.html/);
		assert.equal("note" in rec.entries[3].data, false);
		assert.equal(rec.entries[3].data.summary, "I decided not to write it.", "the final message is kept so the row is not blank");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a complete page whose run died afterwards gets note, not error: it still opens", () => {
	const root = tmp();
	const env = { PI_AGENT_DIR: root } as NodeJS.ProcessEnv;
	const { runs, rec } = harness(env);
	try {
		const started = runs.begin({ topic: "exponential backoff", cwd: "/repo", parentSessionId: "sess-1", model: "m" });
		writeFileSync(join(started.dir, "index.html"), PAGE);
		writeFileSync(join(started.dir, "meta.json"), JSON.stringify({ summary: "Retry with jitter." }));

		rec.started[0].settle({ outcome: "aborted", error: "killed mid follow-up", finalOutput: "done" });

		const data = rec.entries[1].data;
		assert.equal("status" in data, false, "a noted entry is final too");
		assert.equal("error" in data, false, "the page is on disk; nothing fatal happened to the reader");
		assert.match(data.note!, /worker aborted; killed mid follow-up/);
		assert.equal(data.summary, "Retry with jitter.");
		assert.ok(existsSync(join(started.dir, "index.html")));
		assert.ok(rec.wakes[0].includes("viewable in pi-web") && rec.wakes[0].includes("did not finish cleanly"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a fatal run leaves no meta.json behind: meta present must imply a servable page", () => {
	const dir = tmp();
	try {
		// The child inverted the documented order: meta first, then died before the page.
		writeFileSync(join(dir, "meta.json"), JSON.stringify({ ...known(), summary: "written too early" }));
		const check = validateStore(dir, known());
		assert.equal(check.ok, false);
		assert.equal(existsSync(join(dir, "meta.json")), false, "an orphan meta would make the web app list an unservable page");
		assert.ok(check.warnings.some((w) => w.includes("removed a meta.json")));
		assert.equal(dropOrphanMeta(dir), false, "nothing left to drop");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("meta.json is written atomically and leaves no temp file", () => {
	const dir = tmp();
	try {
		const meta = { ...known(), summary: "one paragraph" };
		writeMeta(dir, meta);
		assert.deepEqual(JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")), meta);
		assert.deepEqual(readdirSync(dir), ["meta.json"], "no leftover temp file");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("concurrency is capped and stopAll stops every live child", async () => {
	const root = tmp();
	const env = { PI_AGENT_DIR: root } as NodeJS.ProcessEnv;
	const { runs, rec } = harness(env);
	try {
		for (let n = 0; n < MAX_LIVE; n++) runs.begin({ topic: `topic ${n}`, cwd: "/repo", parentSessionId: "sess-1", model: "m" });
		assert.equal(runs.live, MAX_LIVE);
		assert.equal(new Set(rec.started.map((s) => s.spec.id)).size, MAX_LIVE, "same-millisecond runs get distinct ids");
		assert.equal(rec.entries.length, MAX_LIVE, "one running entry per spawned child");
		assert.throws(() => runs.begin({ topic: "one too many", cwd: "/repo", parentSessionId: "sess-1", model: "m" }), /already running/);
		assert.equal(rec.entries.length, MAX_LIVE, "a refused spawn leaves no phantom running entry");
		await runs.stopAll();
		assert.equal(runs.live, 0);
		assert.ok(rec.started.every((s) => s.killed));
		assert.ok(rec.entries.every((e) => e.data.status === "running"), "a stopped child records no final entry");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a spawn that throws records no running entry and no run", () => {
	const root = tmp();
	const env = { PI_AGENT_DIR: root } as NodeJS.ProcessEnv;
	const entries: ExplainEntryData[] = [];
	const runs = new ExplainRuns({
		env,
		now: () => Date.parse("2026-09-20T10:00:00.000Z"),
		appendEntry: (data) => entries.push(data),
		notify: () => {},
		wake: () => {},
		start: () => {
			throw new Error("spawn pi ENOENT");
		},
	});
	try {
		assert.throws(() => runs.begin({ topic: "monads", cwd: "/repo", parentSessionId: "sess-1", model: "m" }), /ENOENT/);
		assert.deepEqual(entries, []);
		assert.equal(runs.live, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the completion message is hidden: it instructs the agent, it is not user copy", () => {
	const message = wakeMessage(wakeText("monads", "/store/x"));
	assert.equal(message.customType, "explain-complete");
	assert.equal(message.display, false, "a displayed custom message becomes a transcript row showing our prompt plumbing");
	assert.ok(message.content.includes("Reply in at most two sentences"), "the agent still gets its instructions");
});

test("the wake reply is two sentences and never asks for a browser", () => {
	assert.equal(wakeText("monads", "/store/x").split("\n").length, 2);
	assert.ok(!/open|browser/i.test(wakeText("monads", "/store/x").split("\n")[0]));
	assert.ok(wakeText("monads", "/store/x").includes("Do not open a browser"));
	assert.ok(failureWakeText("monads", "boom").includes("failed: boom"));
	assert.equal(oneLineError(undefined, "  a\nb ", "c"), "a b; c");
	assert.match(oneLineError(), /without reporting a reason/);
});

test("the parent identity prefers the session manager and falls back to the environment", () => {
	const env = { PI_SESSION_ID: "env-id", PI_SESSION_FILE: "/env/file.jsonl" } as NodeJS.ProcessEnv;
	assert.deepEqual(parentIdentity({ getSessionId: () => "live", getSessionFile: () => "/live.jsonl" }, env), { id: "live", file: "/live.jsonl" });
	assert.deepEqual(parentIdentity({ getSessionId: () => "live", getSessionFile: () => undefined }, env), { id: "live", file: "/env/file.jsonl" });
	assert.deepEqual(parentIdentity(undefined, env), { id: "env-id", file: "/env/file.jsonl" });
	assert.deepEqual(parentIdentity(undefined, {} as NodeJS.ProcessEnv), { id: "unknown" });
	assert.deepEqual(parentIdentity({ getSessionId: () => { throw new Error("replaced"); }, getSessionFile: () => undefined }, {} as NodeJS.ProcessEnv), { id: "unknown" });
});

// ── the real worker, with a fake pi process ────────────────────────────────

class FakeStream extends EventEmitter {
	push(chunk: string): void {
		this.emit("data", Buffer.from(chunk));
	}
}

class FakeChild extends EventEmitter {
	pid = 4242;
	stdin = Object.assign(new EventEmitter(), {
		writes: [] as string[],
		destroyed: false,
		writableEnded: false,
		writable: true,
		write(chunk: string) {
			this.writes.push(String(chunk));
			return true;
		},
		end() {
			this.writableEnded = true;
		},
		destroy() {
			this.destroyed = true;
		},
	});
	stdout = new FakeStream();
	stderr = new FakeStream();
	kill(): boolean {
		queueMicrotask(() => this.emit("close", 0, null));
		return true;
	}
	lines(): any[] {
		return this.stdin.writes.map((line) => JSON.parse(line.replace(/\n$/, "")));
	}
	reply(id: string, data?: any): void {
		this.stdout.push(`${JSON.stringify({ id, type: "response", command: "reply", success: true, data })}\n`);
	}
}

/** The `-e` sources in argv order. */
function extensionArgs(args: string[]): string[] {
	return args.flatMap((arg, i) => (arg === "-e" ? [args[i + 1]] : []));
}

const flush = (ms = 5) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test("the worker forks the parent, restricts tools, loads only the worker marker, and reports its outcome", async () => {
	const child = new FakeChild();
	const calls: { command: string; args: string[] }[] = [];
	const settles: any[] = [];
	const handle = startExplainWorker(
		{
			id: "vector-clocks-1",
			task: "write the page",
			cwd: process.cwd(),
			model: "zai/glm-5.3",
			effort: "high",
			forkSession: "/tmp/parent.jsonl",
			spawnImpl: (command, args) => {
				calls.push({ command, args });
				return child as unknown as ChildProcess;
			},
			timings: { requestTimeoutMs: 400, abortGraceMs: 20, termGraceMs: 20 },
		},
		{ onSettled: (result) => settles.push(result) },
	);

	const args = calls[0].args;
	assert.deepEqual(args.slice(args.indexOf("--mode"), args.indexOf("--mode") + 2), ["--mode", "rpc"]);
	// With any -e source the runner restricts built-ins by exclusion (an allowlist would strip extension tools).
	const excluded = args[args.indexOf("--exclude-tools") + 1].split(",");
	assert.ok(excluded.length > 0 && excluded.every((tool) => !EXPLAIN_TOOLS.includes(tool)), "only tools outside EXPLAIN_TOOLS are excluded");
	assert.equal(args.includes("--tools"), false);
	assert.ok(args.includes("--no-extensions"), "the child cannot spawn children of its own");
	assert.deepEqual(extensionArgs(args), [WORKER_MARK_EXTENSION], "the marker and nothing else");
	assert.deepEqual(args.slice(args.indexOf("--fork"), args.indexOf("--fork") + 2), ["--fork", "/tmp/parent.jsonl"]);
	assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), ["--model", "zai/glm-5.3"]);
	assert.deepEqual(args.slice(args.indexOf("--thinking"), args.indexOf("--thinking") + 2), ["--thinking", "high"]);

	await flush();
	for (const line of child.lines()) {
		if (line.type === "get_state") child.reply(line.id, { sessionId: "child-1", sessionFile: "/tmp/child.jsonl", model: { provider: "zai", id: "glm-5.4" } });
	}
	await flush();
	for (const line of child.lines()) if (line.type === "prompt") child.reply(line.id);
	await flush();
	assert.ok(child.lines().some((line) => line.type === "prompt" && line.message === "write the page"));

	child.stdout.push(`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: "wrote the page" } })}\n`);
	child.stdout.push(`${JSON.stringify({ type: "agent_settled" })}\n`);
	await flush();

	assert.equal(settles.length, 1);
	assert.equal(settles[0].outcome, "success");
	assert.equal(settles[0].model, "zai/glm-5.4");
	assert.equal(settles[0].finalOutput.includes("wrote the page"), true);
	assert.equal(handle.sessionId, "child-1");
	await handle.kill();
	await flush();
	assert.equal(settles.length, 1, "teardown after a recorded run does not settle twice");
});

test("the worker marker is loaded first, before web search", () => {
	assert.ok(WORKER_MARK_EXTENSION.endsWith(join("subagents", "worker-mark.ts")));
	assert.ok(existsSync(WORKER_MARK_EXTENSION), "resolved from worker.ts's own location");
	const calls: string[][] = [];
	const child = new FakeChild();
	const handle = startExplainWorker(
		{
			id: "x-1",
			task: "t",
			cwd: process.cwd(),
			extensions: ["/agent/npm/node_modules/pi-web-access"],
			spawnImpl: (_command, args) => {
				calls.push(args);
				return child as unknown as ChildProcess;
			},
			timings: { requestTimeoutMs: 400, abortGraceMs: 20, termGraceMs: 20 },
		},
		{ onSettled: () => {} },
	);
	assert.deepEqual(extensionArgs(calls[0]), [WORKER_MARK_EXTENSION, "/agent/npm/node_modules/pi-web-access"], "mark first, like every subagents pi worker");
	void handle.kill();
});

test("web search is offered only when pi already installed it", () => {
	const root = tmp();
	try {
		assert.equal(webAccessExtension({ PI_AGENT_DIR: root } as NodeJS.ProcessEnv), undefined);
		const dir = join(root, "npm", "node_modules", "pi-web-access");
		mkdirSync(dir, { recursive: true });
		assert.equal(webAccessExtension({ PI_AGENT_DIR: root } as NodeJS.ProcessEnv), dir);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
