/** Assessment transport. Node builtins only. Nothing here runs by itself: no session, worker or hook captures or observes. */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

export type AssessmentReply = Record<string, unknown>;
export type AssessmentCall = (core: string, cwd: string, args: string[], signal?: AbortSignal) => Promise<AssessmentReply>;

/** Bounded, no-shell subprocess; a truncated/failed transport is explicitly unavailable, never an empty success. */
export const callAssessment: AssessmentCall = (core, cwd, args, signal) => new Promise((resolve) => {
 let stdout = "", stderr = "", bytes = 0, finished = false;
 const decoder = new StringDecoder("utf8");
 const done = (value: AssessmentReply) => { if (!finished) { finished = true; resolve(value); } };
 const child = spawn(process.execPath, [join(core, "sova-spec-assess.mjs"), ...args, "--root", cwd, "--json"], { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], timeout: 15_000, signal });
 child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) { child.kill(); done({ exit: 2, unavailable: "assessment output exceeded transport limit" }); } else stdout += decoder.write(chunk); });
 child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(0, 1000); });
 child.on("error", () => done({ exit: 2, unavailable: "assessment subprocess unavailable" }));
 child.on("close", (code, signal) => {
  try { const value = JSON.parse(stdout + decoder.end()); if (!value || typeof value !== "object" || Array.isArray(value) || signal || !Number.isInteger(value.exit) || value.exit !== code) throw new Error(); done(value); }
  catch { done({ exit: 2, unavailable: stderr ? "assessment subprocess returned no structured result" : "assessment result missing or unreadable" }); }
 });
});
