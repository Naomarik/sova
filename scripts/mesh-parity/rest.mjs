// The REST script: every route of the baseline, on the fixture sessions, in a fixed order, mutations
// included. Each step is a function of the fixture paths and of earlier answers (a created group's
// id), so the two sides run the identical sequence. `routeCoverage` proves every baseline route was
// exercised: a route added to the list of the server but forgotten here fails the run.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// A 1x1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const q = (path) => encodeURIComponent(path);

/**
 * @param f fixture name → session path; cwd: the fixture cwd; home: the side's HOME
 * @returns an array of steps { name, method, url, body?, headers?, raw?: true (compare status + type only) , after?(json, state) }
 */
export function restSteps({ f, cwd, extra = [] }) {
  const J = (name, method, url, body, extra = {}) => ({ name, method, url, body: body === undefined ? undefined : JSON.stringify(body), headers: body === undefined ? {} : { "content-type": "application/json" }, ...extra });
  const G = (name, url, extra) => J(name, "GET", url, undefined, extra);
  const steps = [
    G("health", "/api/health"),
    G("sessions", "/api/sessions"),
    G("session-groups", "/api/session-groups"),
    G("cwds", "/api/cwds"),
    G("targets", "/api/targets"),
    G("targets-folders-unknown", "/api/targets/nope/folders"),
    G("folders-cwd", `/api/folders?path=${q(cwd)}`),
    G("folders-home", "/api/folders"),
    G("folders-hidden", `/api/folders?path=${q(cwd)}&hidden=1`),
    G("folders-missing", "/api/folders?path=/nonexistent/sova-parity"),
    G("files", `/api/files?cwd=${q(cwd)}`),
    G("files-missing", "/api/files"),
    G("models", "/api/models"),
    G("settings-models", "/api/settings/models"),
    G("themes", "/api/themes"),
    G("playbooks", `/api/playbooks?cwd=${q(cwd)}`),
    G("playbooks-nocwd", "/api/playbooks"),
    G("settings", "/api/settings"),
    G("settings-delegate", "/api/settings/delegate"),
    G("settings-delegate-options", "/api/settings/delegate/options"),
    G("settings-spec", "/api/settings/spec"),
    G("settings-spec-options", "/api/settings/spec/options"),
    G("settings-summarizer", "/api/settings/summarizer"),
    G("settings-claude-status", "/api/settings/claude-status"),
    G("mode", "/api/mode"),
    G("insights-usage", "/api/insights/usage"),
    G("insights-agents", "/api/insights/agents"),
    G("explanations", "/api/explanations"),
    G("explanations-filtered", `/api/explanations?session=01970000-0000-7000-8000-000000000001`),
    G("extensions", "/api/extensions"),
    G("api-404", "/api/does-not-exist"),
    J("api-404-post", "POST", "/api/does-not-exist", {}),
    G("attachment-outside", "/api/attachment?path=/etc/passwd"),
    J("attachment-delete-outside", "DELETE", "/api/attachment?path=/etc/passwd"),
    G("ext-unknown", "/ext/nope"),
    G("ext-unknown-api", "/ext/nope/api/x"),
    G("ext-unknown-ws", "/ext/nope/ws/x"),
    G("ext-bare", "/ext/"),
    G("design-tokens", "/design/tokens.css"),
    G("design-base", "/design/base.css"),
    G("design-missing", "/design/nope.css"),
    G("explain-unknown", "/explain/nope"),
    G("explain-bare", "/explain"),
    G("explain-nested", "/explain/a/b"),
    // The SPA shell and a deep link: the bundle names are hashed per build, so status + type only.
    G("spa-root", "/", { raw: true }),
    G("spa-deep", "/some/client/route", { raw: true }),
  ];
  for (const [name, path] of Object.entries(f)) {
    steps.push(G(`transcript:${name}`, `/api/transcript?path=${q(path)}`));
    steps.push(G(`insights-session:${name}`, `/api/insights/session?path=${q(path)}`));
    steps.push(G(`git:${name}`, `/api/sessions/git?path=${q(path)}`));
    steps.push(G(`context:${name}`, `/api/sessions/context?path=${q(path)}`));
    steps.push(G(`draft:${name}`, `/api/sessions/draft?path=${q(path)}`));
  }
  for (const route of ["/api/transcript", "/api/insights/session", "/api/sessions/git", "/api/sessions/context", "/api/sessions/draft"]) {
    steps.push(G(`${route}:no-path`, route));
    steps.push(G(`${route}:outside`, `${route}?path=${q("/etc/passwd.jsonl")}`));
    steps.push(G(`${route}:missing`, `${route}?path=${q(f["real-chat"].replace(/[^/]+$/, "missing.jsonl"))}`));
  }
  steps.push(
    // Mutations, each followed by the read that shows it.
    J("draft-put", "PUT", "/api/sessions/draft", { path: f["real-chat"], text: "a parity draft" }),
    J("draft-put-bad", "PUT", "/api/sessions/draft", { path: f["real-chat"], text: 3 }),
    G("draft-after", `/api/sessions/draft?path=${q(f["real-chat"])}`),
    J("group-create", "POST", "/api/session-groups", { name: "Parity group" }, { save: "group" }),
    J("group-create-bad", "POST", "/api/session-groups", { name: "" }),
    (s) => J("group-patch", "PATCH", `/api/session-groups/${s.group?.id}`, { name: "Parity group, renamed" }),
    J("group-patch-unknown", "PATCH", "/api/session-groups/nope", { name: "x" }),
    (s) => J("group-assign", "POST", "/api/session-groups/assign", { path: f.compacted, groupId: s.group?.id, label: "lead" }),
    (s) => J("group-assign-2", "POST", "/api/session-groups/assign", { path: f.branched, groupId: s.group?.id }),
    J("group-assign-bad", "POST", "/api/session-groups/assign", { path: f.compacted, groupId: 7 }),
    G("session-groups-after", "/api/session-groups"),
    (s) => J("group-prompt-bad", "POST", `/api/session-groups/${s.group?.id}/prompt`, { text: 3 }),
    J("fanout-bad", "POST", "/api/session-groups/fanout", { members: [] }),
    J("title", "POST", "/api/sessions/title", { path: f.branched, title: "Renamed by parity" }),
    J("title-bad", "POST", "/api/sessions/title", { path: f.branched, title: "" }),
    J("title-null-body", "POST", "/api/sessions/title", null),
    J("archive", "POST", "/api/sessions/archive", { path: f["second-model"], archived: true }),
    J("archive-bad", "POST", "/api/sessions/archive", { path: f["second-model"], archived: "yes" }),
    J("favorite", "PUT", "/api/models/favorite", { ref: "zai/glm-5.3", favorite: true }),
    J("favorite-bad", "PUT", "/api/models/favorite", { ref: 3 }),
    G("models-after", "/api/models"),
    (s) => J("settings-models-put", "PUT", "/api/settings/models", s.get["settings-models"]),
    (s) => J("settings-put", "PUT", "/api/settings", s.get.settings),
    J("settings-put-bad", "PUT", "/api/settings", { experimental: 3 }),
    (s) => J("settings-summarizer-put", "PUT", "/api/settings/summarizer", s.get["settings-summarizer"]?.settings),
    // The chat phase's background outliner then runs on the cheap test model (rule 7), not on the
    // default claude-code → ollama chain, whose latency made the outline race the end of the run.
    J("settings-summarizer-put-glm", "PUT", "/api/settings/summarizer", { primary: { backend: "pi", model: "zai/glm-5.3" }, fallback: null }),
    G("settings-summarizer-after", "/api/settings/summarizer"),
    J("settings-delegate-put-bad", "PUT", "/api/settings/delegate", { version: 9 }),
    J("settings-spec-put-bad", "PUT", "/api/settings/spec", { version: 9 }),
    J("mode-post-bad", "POST", "/api/mode", { mode: 3 }),
    J("mode-post-savedefault-nopath", "POST", "/api/mode", { saveDefault: true }),
    J("mode-post-unheld", "POST", `/api/mode?path=${q(f["real-chat"])}`, { mode: "normal" }),
    J("sandbox-unheld", "POST", `/api/sandbox?path=${q(f["real-chat"])}`, { on: true }),
    J("sandbox-nopath", "POST", "/api/sandbox", {}),
    J("workers-resume-badid", "POST", `/api/workers/resume?path=${q(f["real-chat"])}&id=nope`),
    J("workers-resume-unheld", "POST", `/api/workers/resume?path=${q(f["real-chat"])}&id=ag_01`),
    J("fork", "POST", "/api/sessions/fork", { path: f["real-chat"], entryId: "a1000006", position: "before" }),
    J("fork-bad", "POST", "/api/sessions/fork", { path: f["real-chat"], entryId: "nope", position: "at" }),
    J("cleanup-husks-dry", "POST", "/api/sessions/cleanup", { mode: "husks", dryRun: true }),
    J("cleanup-age-dry", "POST", "/api/sessions/cleanup", { mode: "age", minAgeDays: 30, dryRun: true }),
    J("cleanup-paths-dry", "POST", "/api/sessions/cleanup", { mode: "paths", paths: [f["second-model"]], dryRun: true }),
    J("cleanup-bad", "POST", "/api/sessions/cleanup", { mode: "age", minAgeDays: 3 }),
    { name: "upload-tmp", method: "POST", url: "/api/upload", body: PNG, headers: { "content-type": "image/png" }, save: "upload" },
    { name: "upload-draft", method: "POST", url: `/api/upload?draft=${q(f["real-chat"])}`, body: PNG, headers: { "content-type": "image/png" }, save: "uploadDraft" },
    { name: "upload-bad-type", method: "POST", url: "/api/upload", body: Buffer.from("x"), headers: { "content-type": "text/plain" } },
    (s) => G("attachment-get", `/api/attachment?path=${q(s.upload?.path ?? "")}`, { binary: true }),
    (s) => J("attachment-delete", "DELETE", `/api/attachment?path=${q(s.uploadDraft?.path ?? "")}`),
    J("usage-refresh", "POST", "/api/insights/usage/refresh"),
    G("insights-usage-after", "/api/insights/usage"),
    J("sessions-create", "POST", "/api/sessions", { cwd }, { save: "created" }),
    (s) => J("archive-web", "POST", "/api/sessions/archive", { path: s.created?.path, archived: true }),
    (s) => J("unarchive-web", "POST", "/api/sessions/archive", { path: s.created?.path, archived: false }),
    (s) => J("title-web", "POST", "/api/sessions/title", { path: s.created?.path, title: "Web session title" }),
    (s) => J("title-web-clear", "POST", "/api/sessions/title", { path: s.created?.path, title: null }),
    J("sessions-create-missing", "POST", "/api/sessions", { cwd: "/nonexistent/sova-parity" }),
    J("sessions-create-badjson", "POST", "/api/sessions", undefined, { body: "{", headers: { "content-type": "application/json" } }),
    J("sessions-create-unknown-target", "POST", "/api/sessions", { target: "nope", remoteCwd: "/x" }),
    J("sessions-connect", "POST", "/api/sessions/connect"),
    (s) => J("group-delete", "DELETE", `/api/session-groups/${s.group?.id}`),
    J("group-delete-unknown", "DELETE", "/api/session-groups/nope"),
    ...extra,
    G("sessions-after", "/api/sessions"),
    G("cwds-after", "/api/cwds"),
  );
  return steps;
}

/** Run the steps against one server; returns [{name, method, url, status, type, body}] in order. */
export async function runRest(base, steps) {
  const state = { get: {} };
  const out = [];
  for (const s0 of steps) {
    const s = typeof s0 === "function" ? s0(state) : s0;
    let status, type, body;
    try {
      const r = await fetch(base + s.url, { method: s.method, headers: s.headers, body: s.body, redirect: "manual" });
      status = r.status;
      type = r.headers.get("content-type");
      const buf = Buffer.from(await r.arrayBuffer());
      if (s.raw) body = `<${buf.length > 0 ? "non-empty" : "empty"}>`;
      else if (s.binary) body = `<sha:${(await import("node:crypto")).createHash("sha256").update(buf).digest("hex")}>`;
      else {
        const text = buf.toString("utf8");
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      if (r.headers.get("location")) body = { location: r.headers.get("location"), body };
    } catch (err) {
      status = "fetch-error";
      body = String(err);
    }
    if (s.method === "GET" && status === 200) state.get[s.name] = body;
    if (s.save && status >= 200 && status < 300) state[s.save] = body;
    out.push({ name: s.name, method: s.method, url: s.url, status, type, body });
  }
  return out;
}

/** Every `app.<method>("<path>"` registered in a tree's server/*.ts (tests excluded). */
export function serverRoutes(tree) {
  const dir = join(tree, "server");
  const routes = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    const src = readFileSync(join(dir, file), "utf8");
    for (const m of src.matchAll(/\bapp\.(get|post|put|patch|delete|all)\(\s*(["`])([^"`]+)\2/g)) routes.push({ method: m[1].toUpperCase(), path: m[3], file });
  }
  return routes;
}

/** Routes of `routes` that no executed request matched. */
export function uncoveredRoutes(routes, executed) {
  const esc = (t) => t.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const toRe = (p) => new RegExp("^" + p.split(/(\$\{name\}|:[A-Za-z]+|\*)/).map((t) => (t === "*" ? ".*" : t.startsWith(":") || t === "${name}" ? "[^/]+" : esc(t))).join("") + "$");
  return routes.filter((r) => {
    const re = toRe(r.path);
    return !executed.some((e) => (r.method === "ALL" || r.method === e.method) && re.test(new URL(e.url, "http://x").pathname));
  });
}
