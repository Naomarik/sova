import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Run with no helper profile: this process's chats get none unless a default names one (an "off" default
 * names none), and the agent dir's device default is "off" unless it already has a default. Returns the dir.
 * Under any profile every team member needs a work kind (or a model); tests about the team machinery, not
 * member routing, run their teams with no profile routing them.
 */
export function profileOff(agentDir: string): string {
	process.env.SOVA_NO_HELPER_PROFILE = "1";
	fs.mkdirSync(agentDir, { recursive: true });
	try {
		fs.writeFileSync(path.join(agentDir, "subagent-profiles-default.json"), JSON.stringify({ version: 1, default: "off" }), { flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	return agentDir;
}
