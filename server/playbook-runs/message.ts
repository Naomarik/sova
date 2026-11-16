// The one message Start gives the main chat: an
// instruction line, the playbook block (shared/playbook-delivery.ts) and the run block: your choices, the cast
// with each role's whole model list, which steps run as a team and which as separate helpers, the steps and
// their stops, the cycle, and the playbook contents page with its entry for Sova's commands. Pure.
import type { PlanModel, PlaybookPlan } from "./plan";

export interface ContentsSection {
  name: string;
  /** The section's line in the contents page. */
  line: string;
  /** Where the run can read it: an absolute path. */
  file: string;
}

const q = (s: string) => s.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

const modelWords = (m: PlanModel): string => `${m.model}${m.effort ? ` (${m.effort})` : ""}${m.why ? ` [can't run now: ${m.why}]` : ""}`;

/** The instruction line before the blocks. */
export const runInstruction = (title: string): string =>
  `Run the playbook "${title}" as its conductor: its recipe is in the playbook block below and this run's plan, frozen from the card the user started, in the run block after it. Start the helpers and teams yourself, exactly as the run block says.`;

export function runBlock(plan: PlaybookPlan, folder: string, opts: { contents: ContentsSection[]; sovaScript: string }): string {
  const lines: string[] = [`<run id="${plan.runId}" playbook="${q(plan.playbook.id)}" revision="${plan.revision}" folder="${q(folder)}">`];
  lines.push(`Run folder: ${folder} (plan.json, one brief per helper in briefs/, team layouts in teams/, the contents pages in know-how/). Write the run's output where the playbook says; never in this folder's briefs.`);

  lines.push("", "Your choices (the user's, frozen at Start):");
  if (!plan.choices.length) lines.push("- (none)");
  for (const c of plan.choices) lines.push(`- ${c.label} [${c.id}]: ${c.text}`);
  if (plan.text) lines.push("", `The user's words with the playbook: ${plan.text}`);

  lines.push("", "Cast (each model list in order; start each role on its first model that can run):");
  for (const r of plan.roles) {
    const list = r.chain.map(modelWords).join(" → ") || "(none named: this chat's own model)";
    if (r.main) {
      lines.push(`- ${r.label} (you, the conductor): ${list}.${r.reason ? ` Starts on ${r.chain[r.use]?.model ?? "this chat's model"}: ${r.reason}.` : ""}`);
      continue;
    }
    const how = r.team ? `in team "${r.team}"` : "as separate helpers (agent_spawn, one per brief)";
    const many = r.items?.length ? ` ×${r.count}, one per item: ${r.items.join(", ")}` : r.count > 1 ? ` ×${r.count}` : "";
    const parts = [
      `- ${r.label} [${r.id}]${many}${r.kind ? `, kind ${r.kind}` : ""}: ${list}.`,
      r.only ? "Only these models: if none of them can run, stop and ask the user; never pick another." : "When the list runs out, use the kind's model from the user's profile, then this chat's model.",
      r.reason ? `Starts on entry ${r.use + 1}: ${r.reason}.` : "",
      `Runs ${how}.`,
      `Brief${r.briefs.length > 1 ? "s" : ""}: ${r.briefs.map((b) => `${folder}/${b}`).join(", ")} (give it whole as the helper's task).`,
      r.sees === "blind" ? "Blind: never tell it which arm or version produced what it judges." : "",
      r.fresh === "cycle" ? "Start it anew each cycle." : "",
      r.note ? `The user's note for it: ${r.note}` : "",
    ];
    lines.push(parts.filter(Boolean).join(" "));
  }

  if (plan.teams.length) {
    lines.push("", "Teams: create each with team_create, passing the JSON in its file as the arguments (models already resolved). Sova adds a coordinator and a monitor to every team; they are part of the plan.");
    for (const t of plan.teams) lines.push(`- ${t.label} [${t.id}]: ${folder}/${t.file} (roles: ${t.roles.join(", ")})`);
  }

  lines.push("", "Steps, in order:");
  plan.steps.forEach((s, i) => {
    const runs = s.runs === "main" ? "you" : s.runs === "team" ? `team "${s.team}"` : `separate helpers: ${s.roles.filter((r) => r !== "main").join(", ")}`;
    const bits = [
      `${i + 1}. ${s.label} [${s.id}]${s.cycle ? ` (in cycle "${s.cycle}")` : ""}: ${runs}.`,
      s.phase ? `When it begins, read ${s.phase} with playbook_read.` : "",
      s.report ? `Show a ${s.report} before it counts as done.` : "",
      s.asks.length ? `Also stop and ask if: ${s.asks.join("; ")}.` : "",
      s.stop ? "STOP after it: give the report, then wait for the user's answer (Continue, Stop Here, or their own words)." : "",
    ];
    lines.push(bits.filter(Boolean).join(" "));
  });
  if (plan.cycle) {
    const c = plan.cycle;
    lines.push(
      "",
      `Cycle "${c.label}" (steps ${c.steps.join(", ")}): at most ${c.max} cycle${c.max === 1 ? "" : "s"}; stop and ask the user after every ${c.askEvery === 1 ? "cycle" : `${c.askEvery} cycles`} and at the end. ${c.until === "rule" ? `Stop going round once the stop rule is met${c.rule ? `: ${c.rule}` : ""}.` : `Run all ${c.max} cycles; report the stop rule${c.rule ? ` (${c.rule})` : ""} without stopping for it.`}${c.carry ? ` Into the next cycle: ${c.carry}.` : ""} Show a chart or table of every cycle so far after each one.`,
    );
  }

  lines.push("", "How it runs:");
  lines.push(`- ${plan.run.chat === "new" ? "This chat was opened for this run." : "In this chat."}${plan.run.worktree === "new" ? " Do the work in a new worktree: create one for this run before the first step that changes files." : ""}`);
  lines.push("- When a model is refused or stops working, move that role to the next model on its list and say so in your next message (from, to, why). An \"only these models\" role whose list runs out: stop and wait for the user.");
  lines.push("- At a stop point, end your turn with the report and wait. Nothing past a stop runs without the user's answer.");
  if (plan.commands.length) lines.push(`- Sova commands this playbook may use that change things: ${plan.commands.join(", ")}.`);

  lines.push("", "Playbook contents (how a playbook is built; read a section only when you need it):");
  for (const s of opts.contents) lines.push(`- ${s.line} — ${s.file}`);
  lines.push(
    `- Sova's commands: what Sova itself can do from a script (list chats, read a chat, start or stop one, run a project's services and tests, read the merge queue). List them with \`node ${opts.sovaScript} list\`, read one with \`node ${opts.sovaScript} describe <id>\`, run it with \`node ${opts.sovaScript} run <id> …\`. Actions only the user's own click may do (Land, Start on a card, approvals, restarting Sova) are refused to you, as to every chat.`,
  );
  lines.push("</run>");
  return lines.join("\n");
}

/** The whole message: instruction, playbook block, run block. */
export const runMessage = (plan: PlaybookPlan, playbookBlock: string, run: string): string => [runInstruction(plan.playbook.title), playbookBlock, run].join("\n");
