// Run: npx tsx --test server/explanations.test.ts
// Uses a throwaway PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written, and
// the server is imported with PORT=0 so it binds an ephemeral port instead of the dev port.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { ExplanationInfo } from "../shared/protocol";

const agentDir = mkdtempSync(join(tmpdir(), "pi-web-explain-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
process.env.PORT = "0";
const storeDir = join(agentDir, "explanations");
const sessionsDir = join(agentDir, "sessions", "--tmp-explain-test--");
mkdirSync(storeDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
mkdirSync(sessionsDir, { recursive: true });

const { explanationsDir, hasPage, isExplanationId, listExplanations, readExplanationPage } = await import("./explanations");
const { normalizeEntries, normalizeEntry } = await import("./transcript");
const { getSessionInsight } = await import("./insights");
const { canonicalPath } = await import("./paths");
const { app, server } = await import("./index");

after(() => {
  server.close();
  rmSync(agentDir, { recursive: true, force: true });
});

interface StoreEntry {
  id: string;
  topic?: string;
  summary?: string;
  createdAt?: string;
  parentSessionId?: string;
  html?: string | null; // null: meta.json but no index.html (a failed or half-written run)
  model?: string | null; // null: an older store, written before the extension recorded it
  meta?: string; // raw meta.json text, instead of a well-formed one
}

function store(e: StoreEntry): void {
  const dir = join(storeDir, e.id);
  mkdirSync(dir, { recursive: true });
  if (e.html !== null) writeFileSync(join(dir, "index.html"), e.html ?? `<!doctype html><title>${e.id}</title>`);
  const meta =
    e.meta ??
    JSON.stringify({
      id: e.id,
      topic: e.topic ?? `Topic ${e.id}`,
      summary: e.summary ?? `Summary ${e.id}`,
      parentSessionId: e.parentSessionId ?? "sess-a",
      cwd: "/tmp",
      createdAt: e.createdAt ?? "2026-09-20T00:00:00.000Z",
      ...(e.model === null ? {} : { model: e.model ?? "anthropic/claude-opus-5" }),
    });
  writeFileSync(join(dir, "meta.json"), meta);
}

const ids = (list: ExplanationInfo[]) => list.map((x) => x.id);

store({ id: "aaa", createdAt: "2026-09-18T10:00:00.000Z", parentSessionId: "sess-a", topic: "Oldest" });
store({ id: "bbb", createdAt: "2026-09-20T10:00:00.000Z", parentSessionId: "sess-b", topic: "Newest" });
store({ id: "ccc", createdAt: "2026-09-19T10:00:00.000Z", parentSessionId: "sess-a", topic: "Middle" });
store({ id: "half-written", meta: '{"id":"half-written","topic":"No createdAt"}' });
store({ id: "truncated", meta: '{"id":"trunc' });
store({ id: "not-an-object", meta: "[1,2,3]" });
store({ id: "mismatched", meta: JSON.stringify({ id: "somebody-else", topic: "t", createdAt: "2026-09-20T00:00:00.000Z" }) });
store({ id: "ddd", parentSessionId: "sess-note", topic: "Store topic", createdAt: "2026-09-20T11:00:00.000Z" });
store({ id: "zai-page", model: "zai/glm-5.3", parentSessionId: "sess-model" });
store({ id: "old-page", model: null, parentSessionId: "sess-model" }); // an older store: no model key
store({ id: "blank-model", model: "", parentSessionId: "sess-model" }); // meta key present but empty
store({ id: "no-page", html: null, topic: "Meta without a page" });
store({ id: "empty-page", html: "", topic: "Zero-byte page" });
mkdirSync(join(storeDir, "no-meta"), { recursive: true });
writeFileSync(join(storeDir, "loose-file.html"), "not a dir");

describe("explanations store", () => {
  test("lists every readable entry, newest first", async () => {
    assert.deepEqual(ids(await listExplanations()), ["ddd", "bbb", "zai-page", "old-page", "blank-model", "ccc", "aaa"]);
  });

  test("filters by parentSessionId", async () => {
    assert.deepEqual(ids(await listExplanations("sess-a")), ["ccc", "aaa"]);
    assert.deepEqual(ids(await listExplanations("sess-b")), ["bbb"]);
    assert.deepEqual(await listExplanations("sess-nobody"), []);
  });

  test("entries carry exactly the ExplanationInfo fields", async () => {
    const [newest] = await listExplanations("sess-b");
    assert.deepEqual(newest, {
      id: "bbb",
      topic: "Newest",
      summary: "Summary bbb",
      createdAt: "2026-09-20T10:00:00.000Z",
      parentSessionId: "sess-b",
      model: "anthropic/claude-opus-5",
    });
  });

  test("corrupt, partial, foreign and meta-less entries are skipped, not thrown", async () => {
    const listed = ids(await listExplanations());
    for (const skipped of ["half-written", "truncated", "not-an-object", "mismatched", "no-meta", "loose-file.html"])
      assert.ok(!listed.includes(skipped), `expected ${skipped} to be skipped`);
  });

  test("model comes through from meta.json, and stays absent on an older store", async () => {
    const list = await listExplanations("sess-model");
    assert.equal(list.find((x) => x.id === "zai-page")?.model, "zai/glm-5.3");
    const old = list.find((x) => x.id === "old-page");
    assert.ok(old);
    assert.equal("model" in old, false); // absent, never ""
    // meta.json always carries the key as a string and can hold "" (a parent session with no
    // active model), so the reader, not the writer, is what keeps "" off the wire.
    const blank = list.find((x) => x.id === "blank-model");
    assert.ok(blank);
    assert.equal("model" in blank, false);
  });

  test("a meta without a servable page is not listed: everything listed is openable", async () => {
    const listed = ids(await listExplanations());
    assert.ok(!listed.includes("no-page"));
    assert.ok(!listed.includes("empty-page")); // zero bytes is not a page
    assert.equal(await hasPage("aaa"), true);
    assert.equal(await hasPage("no-page"), false);
  });

  test("the store root follows PI_AGENT_DIR first, like the extension that writes it", () => {
    const prev = { agent: process.env.PI_AGENT_DIR, coding: process.env.PI_CODING_AGENT_DIR };
    try {
      process.env.PI_AGENT_DIR = "/custom/agent";
      assert.equal(explanationsDir(), "/custom/agent/explanations");
      delete process.env.PI_AGENT_DIR;
      assert.equal(explanationsDir(), join(agentDir, "explanations")); // falls back to PI_CODING_AGENT_DIR
    } finally {
      if (prev.agent === undefined) delete process.env.PI_AGENT_DIR;
      else process.env.PI_AGENT_DIR = prev.agent;
      process.env.PI_CODING_AGENT_DIR = prev.coding!;
    }
  });

  test("a missing store dir is an empty list", async () => {
    const prev = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(agentDir, "nope");
    try {
      assert.deepEqual(await listExplanations(), []);
    } finally {
      process.env.PI_CODING_AGENT_DIR = prev;
    }
  });

  test("isExplanationId accepts store dir names and rejects paths", () => {
    for (const ok of ["aaa", "A_b-9", "0199abcd"]) assert.equal(isExplanationId(ok), true, ok);
    for (const bad of ["", "..", "../etc/passwd", "a/b", "a.b", "a b", "a%2Fb", 42, null, undefined])
      assert.equal(isExplanationId(bad), false, String(bad));
  });

  test("readExplanationPage returns the stored html, and null for unknown or invalid ids", async () => {
    assert.match((await readExplanationPage("aaa")) ?? "", /<title>aaa<\/title>/);
    assert.equal(await readExplanationPage("no-meta"), null); // dir exists, no index.html
    assert.equal(await readExplanationPage("nope"), null);
    assert.equal(await readExplanationPage("../../etc/passwd"), null);
  });
});

describe("GET /api/explanations", () => {
  test("returns every entry newest-first", async () => {
    const res = await app.request("/api/explanations");
    assert.equal(res.status, 200);
    assert.deepEqual(ids((await res.json()) as ExplanationInfo[]), ["ddd", "bbb", "zai-page", "old-page", "blank-model", "ccc", "aaa"]);
  });

  test("?session= filters by parent session", async () => {
    const res = await app.request("/api/explanations?session=sess-a");
    assert.deepEqual(ids((await res.json()) as ExplanationInfo[]), ["ccc", "aaa"]);
  });
});

describe("GET /explain/:id", () => {
  test("serves the page as html, not the SPA shell", async () => {
    const res = await app.request("/explain/aaa");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Type"), "text/html; charset=utf-8");
    assert.match(await res.text(), /<title>aaa<\/title>/);
  });

  test("the query string passes through untouched (the page reads ?theme= itself)", async () => {
    const res = await app.request("/explain/aaa?theme=dark");
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<title>aaa<\/title>/);
  });

  test("no frame-blocking headers: the gallery renders thumbnails in a sandboxed iframe", async () => {
    const res = await app.request("/explain/aaa");
    assert.equal(res.headers.get("X-Frame-Options"), null);
    assert.equal(res.headers.get("Content-Security-Policy"), null);
  });

  test("unknown id, and an id whose dir has no page, are 404", async () => {
    assert.equal((await app.request("/explain/nope")).status, 404);
    assert.equal((await app.request("/explain/no-meta")).status, 404);
  });

  test("encoded traversal, empty and nested ids are 404, never a file read", async () => {
    for (const path of [
      "/explain/%2e%2e%2f%2e%2e%2fetc%2fpasswd",
      "/explain/a%2Fb",
      "/explain/aaa%2F..%2F..%2Fpackage.json",
      "/explain/aaa/index.html",
      "/explain/aaa/",
      "/explain/",
      "/explain",
    ])
      assert.equal((await app.request(path)).status, 404, path);
  });

  test("literal dot-segments never reach the route: URL parsing resolves them first", async () => {
    // What a browser (and Hono's own Request construction) does before routing, so "/explain/.."
    // is a request for "/", not an id of "..".
    assert.equal(new URL("/explain/../../etc/passwd", "http://x").pathname, "/etc/passwd");
    assert.equal(new URL("/explain/..", "http://x").pathname, "/");
    assert.equal(new URL("/explain/%2e%2e", "http://x").pathname, "/"); // encoded ones too
  });
});

const explainEntry = (data: unknown, id = "e1") => ({
  type: "custom",
  id,
  parentId: null,
  timestamp: "2026-09-20T00:00:00.000Z",
  customType: "explain-doc",
  data,
});

const info = (over: Partial<ExplanationInfo> = {}): ExplanationInfo => ({
  id: "xyz",
  topic: "How the watch pipeline works",
  summary: "One honest paragraph about the watcher.",
  createdAt: "2026-09-20T12:00:00.000Z",
  parentSessionId: "sess-a",
  ...over,
});

describe("transcript: explain-doc rows", () => {
  test("becomes a report row carrying the ExplanationInfo", () => {
    const [it] = normalizeEntry(explainEntry(info()));
    assert.ok(it);
    assert.equal(it.kind, "report");
    assert.equal(it.report?.source, "explain-doc");
    assert.equal(it.report?.preview, "How the watch pipeline works"); // the topic, verbatim
    assert.equal(it.report?.body, "One honest paragraph about the watcher.");
    assert.equal(it.report?.truncated, false);
    assert.equal(it.report?.agent, undefined);
    assert.deepEqual(it.report?.explain, info());
    assert.equal(it.text, "One honest paragraph about the watcher.");
  });

  test("non-string fields fall back to empty, missing id/topic/createdAt yield no row", () => {
    const [it] = normalizeEntry(explainEntry({ ...info(), summary: 42, parentSessionId: null }));
    assert.equal(it?.report?.explain?.summary, "");
    assert.equal(it?.report?.explain?.parentSessionId, "");
    for (const bad of [undefined, null, "str", {}, { ...info(), id: "" }, { ...info(), topic: "" }, { ...info(), createdAt: "" }])
      assert.deepEqual(normalizeEntry(explainEntry(bad)), [], JSON.stringify(bad));
  });

  test("the entry's model lands on explain.model, and is tolerated when missing", () => {
    const [withModel] = normalizeEntry(explainEntry({ ...info(), model: "zai/glm-5.3" }));
    assert.equal(withModel?.report?.explain?.model, "zai/glm-5.3");
    const [without] = normalizeEntry(explainEntry(info()));
    assert.equal("model" in (without?.report?.explain ?? {}), false);
    const [blank] = normalizeEntry(explainEntry({ ...info(), model: 42 }));
    assert.equal("model" in (blank?.report?.explain ?? {}), false); // non-string ⇒ absent
  });

  test("model survives a bad run: the extension sets it on failures and notes too", () => {
    const [failed] = normalizeEntry(explainEntry({ ...info(), model: "zai/glm-5.3", error: "worker error" }));
    assert.equal(failed?.report?.explain?.model, "zai/glm-5.3");
    assert.equal(failed?.report?.explain?.error, "worker error");
    const [noted] = normalizeEntry(explainEntry({ ...info(), model: "zai/glm-5.3", note: "worker aborted" }));
    assert.equal(noted?.report?.explain?.model, "zai/glm-5.3");
    assert.equal(noted?.report?.explain?.note, "worker aborted");
  });

  test("a failed run carries its one-line reason on report.error and explain.error", () => {
    const [it] = normalizeEntry(explainEntry({ ...info(), error: "worker error: the child wrote no index.html" }));
    assert.equal(it?.report?.explain?.error, "worker error: the child wrote no index.html");
    assert.equal(it?.report?.error, "worker error: the child wrote no index.html");
    assert.equal(normalizeEntry(explainEntry(info()))[0]?.report?.error, undefined);
    const [ok] = normalizeEntry(explainEntry(info()));
    assert.equal("error" in (ok?.report?.explain ?? {}), false); // absent ⇒ the page is there
    const [blank] = normalizeEntry(explainEntry({ ...info(), error: "" }));
    assert.equal("error" in (blank?.report?.explain ?? {}), false);
  });

  test("an advisory note keeps the row linkable: explain.note, and no report.error", () => {
    const [it] = normalizeEntry(explainEntry({ ...info(), note: "worker aborted after writing the page" }));
    assert.equal(it?.report?.explain?.note, "worker aborted after writing the page");
    assert.equal(it?.report?.explain?.error, undefined);
    assert.equal(it?.report?.error, undefined); // advisory, so the row is not a failure
  });

  test("error wins over note when both are somehow set", () => {
    const [it] = normalizeEntry(explainEntry({ ...info(), error: "fatal", note: "advisory" }));
    assert.equal(it?.report?.explain?.error, "fatal");
    assert.equal(it?.report?.explain?.note, undefined);
    assert.equal(it?.report?.error, "fatal");
  });

  test("every explain-doc on the branch renders (they are separate artifacts, unlike align-doc)", () => {
    const rows = normalizeEntries([
      explainEntry(info({ id: "one" }), "e1"),
      { ...explainEntry(info({ id: "two" }), "e2"), parentId: "e1" },
    ]);
    assert.deepEqual(rows.map((r) => r.report?.explain?.id), ["one", "two"]);
  });
});

describe("insights: session explanations", () => {
  function session(id: string, entries: unknown[]): string {
    const path = join(sessionsDir, `2026-09-20T00-00-00-000Z_${id}.jsonl`);
    const header = { type: "session", version: 3, id, timestamp: "2026-09-20T00:00:00.000Z", cwd: "/tmp" };
    writeFileSync(path, [header, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n");
    return canonicalPath(path);
  }

  test("merges store entries with the branch's, deduped (store wins), newest first", async () => {
    // "ccc" is in both; "gone" only in the JSONL with no store dir; "aaa" only in the store.
    const path = session("sess-a", [
      explainEntry(info({ id: "ccc", topic: "Stale copy", createdAt: "2026-09-19T10:00:00.000Z" }), "e1"),
      { ...explainEntry(info({ id: "gone", topic: "Store dir deleted", createdAt: "2026-09-19T20:00:00.000Z" }), "e2"), parentId: "e1" },
    ]);
    const insight = await getSessionInsight(path);
    assert.deepEqual(insight.explanations?.map((x) => x.id), ["ccc", "aaa"]); // "gone" has no page
    assert.equal(insight.explanations?.find((x) => x.id === "ccc")?.topic, "Middle"); // store, not the JSONL copy
  });

  test("a failed entry is excluded: the strip count and grid list only pages that serve", async () => {
    const path = session("sess-c", [
      // A failed run: the entry is on the branch, no store dir was written.
      explainEntry({ ...info({ id: "crashed", parentSessionId: "sess-c" }), error: "worker error" }, "e1"),
      // Not failed, but its store dir is gone: equally unopenable, equally excluded.
      { ...explainEntry(info({ id: "vanished", parentSessionId: "sess-c" }), "e2"), parentId: "e1" },
    ]);
    assert.deepEqual((await getSessionInsight(path)).explanations, []);
  });

  test("a branch entry the store can still serve is kept, even when its meta names no session", async () => {
    store({ id: "orphan-meta", parentSessionId: "", topic: "Meta without a parent" });
    const path = session("sess-d", [explainEntry(info({ id: "orphan-meta", parentSessionId: "sess-d" }), "e1")]);
    const list = (await getSessionInsight(path)).explanations ?? [];
    assert.deepEqual(list.map((x) => x.id), ["orphan-meta"]);
  });

  test("a noted entry is listed and keeps its note: the page is there, the run broke after", async () => {
    const path = session("sess-note", [
      explainEntry({ ...info({ id: "ddd", parentSessionId: "sess-note" }), note: "worker aborted after writing the page" }, "e1"),
    ]);
    const list = (await getSessionInsight(path)).explanations ?? [];
    assert.deepEqual(list.map((x) => x.id), ["ddd"]);
    assert.equal(list[0]?.note, "worker aborted after writing the page");
    assert.equal(list[0]?.error, undefined);
    assert.equal(list[0]?.topic, "Store topic"); // store copy, carrying the branch's note
  });

  test("every listed entry is openable: none carries error", async () => {
    const list = (await getSessionInsight(session("sess-b", []))).explanations ?? [];
    assert.deepEqual(list.map((x) => x.id), ["bbb"]);
    for (const x of list) assert.equal("error" in x, false);
  });

  test("a session with no explanations gets an empty list", async () => {
    const insight = await getSessionInsight(session("sess-empty", []));
    assert.deepEqual(insight.explanations, []);
  });

  test("another session's store entries are not included", async () => {
    const insight = await getSessionInsight(session("sess-b", []));
    assert.deepEqual(insight.explanations?.map((x) => x.id), ["bbb"]);
  });
});
