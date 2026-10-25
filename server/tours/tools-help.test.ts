// record_tour's always-present help carries the most-missed rules and the full login shape, and its
// status passes the tool's abort signal (Stop) to the waiting status (§app.tours/authoring, /recording).
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { ToolCtx } from "../../shared/harness";
import type { TourJob } from "../../shared/tour";
import { tourManifestFixture } from "../../shared/tour-fixtures";
import { stateView } from "../harness/state-view";
import { setTourToolRuntime, tourTools, type TourToolJob, type TourToolRuntime } from "./tools";

const AT = "2026-01-02T03:04:05.000Z";
const job = (): TourJob => ({ v: 1, id: "job-demo", tourId: "tour-demo", sessionId: "session-demo", title: "Drafts", phase: "dry-run", completed: 0, total: 2, createdAt: AT, updatedAt: AT });
const context = (): ToolCtx => ({ sessionId: "session-demo", cwd: "/projects/demo", leafId: () => null, branch: () => [], state: () => stateView([]) });
afterEach(() => setTourToolRuntime(undefined));

test("record_tour's help names one screen per picture, exactly one match, role and name first, tourId beside the script, and the waiting status", () => {
  const tool = tourTools("session-demo", "/sessions/demo.jsonl")[0]!;
  const line = tool.description.split("\n").find(l => l.startsWith("Rules:"));
  assert.ok(line, "one rules line");
  for (const rule of [/one screen/, /1440×960/, /390×844/, /exactly one visible control/, /role and name first/, /tourId goes beside the script, never inside it/, /status waits/, /never sleep or poll/]) assert.match(line!, rule);
  const props = (tool.parameters as { properties: Record<string, { description?: string }> }).properties;
  assert.match(props.credentials!.description!, /\{account\?, username, password, code\?\}/);
  assert.match(props.op!.description!, /record\(dryRunId, credentials\?\)/);
});

test("status hands the tool's abort signal to the runtime", async () => {
  let seen: AbortSignal | undefined;
  const reply = async (): Promise<TourToolJob> => ({ job: job(), steps: 1 });
  const service: TourToolRuntime = { dryRun: reply, record: reply, cancel: reply, check: reply, inspect: async () => ({ result: await reply(), content: [] }), show: async () => tourManifestFixture(),
    status: async (_caller, _id, signal?: AbortSignal) => { seen = signal; return reply(); } };
  setTourToolRuntime(service);
  const stop = new AbortController();
  await tourTools("session-demo", "/sessions/demo.jsonl")[0]!.execute("call", { op: "status", jobId: "job-demo" }, stop.signal, undefined, context());
  assert.equal(seen, stop.signal);
});
