import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Put an agent dir's device default on Off, unless it already has a default, and return the dir.
 * Under any other profile every team member needs a work kind (or a model); tests about the team
 * machinery, not member routing, run their teams with no profile routing them.
 */
export function profileOff(agentDir: string): string {
	fs.mkdirSync(agentDir, { recursive: true });
	try {
		fs.writeFileSync(path.join(agentDir, "subagent-profiles-default.json"), JSON.stringify({ version: 1, default: "off" }), { flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	return agentDir;
}
