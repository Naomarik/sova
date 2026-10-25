/**
 * Test-only extension for `fork-cache-live.mjs`: `/fork-probe [task]` starts one background fork
 * of this session through the shared core (`../fork/`), exactly the calls /explain makes — copy,
 * Claude fork point, `startBackgroundFork` — with a read-only policy and a run-private session dir,
 * and announces where the child's session landed when it settles. Never loaded outside that test.
 * The fork is a hidden chat started by Sova's worker host, so the parent must be a chat of a Sova
 * server (a bare `pi --mode rpc` parent has no host and the probe says so).
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { claudeForkPointFor, startBackgroundFork, workerHostOf, type BackgroundForkHandle } from "../fork/background.ts";
import { copyForFork } from "../fork/copy.ts";

export const PROBE_DIR_ENV = "PI_FORK_PROBE_DIR";

export default function forkProbe(pi: ExtensionAPI): void {
	const live: BackgroundForkHandle[] = [];
	const host = workerHostOf(pi.events);
	pi.on("session_shutdown", async () => {
		await Promise.all(live.map((handle) => handle.stop().catch(() => {})));
	});
	pi.registerCommand("fork-probe", {
		description: "test only: start one background fork of this session",
		handler: async (args, ctx) => {
			const root = process.env[PROBE_DIR_ENV];
			const file = ctx.sessionManager.getSessionFile();
			if (!root || !file) {
				ctx.ui.notify(`FORK-PROBE-ERROR ${!root ? `${PROBE_DIR_ENV} is not set` : "this session is not on disk"}`, "error");
				return;
			}
			const id = `${Date.now()}`;
			const dir = join(root, id);
			const sessionDir = join(dir, "sessions");
			mkdirSync(sessionDir, { recursive: true });
			const copy = join(dir, "copy.jsonl");
			if (!copyForFork(file, copy)) {
				ctx.ui.notify("FORK-PROBE-ERROR nothing to copy", "error");
				return;
			}
			const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const claudeFork = claudeForkPointFor(model, ctx.sessionManager.getSessionId());
			let handle: BackgroundForkHandle;
			try {
				handle = startBackgroundFork(
					{
						host: host.current(),
						kind: "explain",
						parent: { sessionId: ctx.sessionManager.getSessionId(), path: file },
						id,
						name: "fork-probe",
						task: args.trim() || "Reply with exactly FORKED and nothing else. Do not call any tool.",
						cwd: ctx.cwd,
						...(model ? { model } : {}),
						...(ctx.thinkingLevel ? { effort: ctx.thinkingLevel } : {}),
						forkSession: copy,
						sessionDir,
						policy: { label: "The fork probe" },
						...(claudeFork ? { claudeFork } : {}),
					},
					{
						onSettled: (result) =>
							ctx.ui.notify(`FORK-PROBE-SETTLED ${JSON.stringify({ ...result, sessionDir, sessionFile: handle.sessionFile, claudeFork: Boolean(claudeFork) })}`, "info"),
					},
				);
			} catch (error) {
				ctx.ui.notify(`FORK-PROBE-ERROR ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
			live.push(handle);
			ctx.ui.notify(`FORK-PROBE-STARTED ${JSON.stringify({ sessionDir, claudeFork: Boolean(claudeFork) })}`, "info");
		},
	});
}
