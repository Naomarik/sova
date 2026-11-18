// The one message Start gives the main chat: an
// instruction line, the playbook block (shared/playbook-delivery.ts) and the run block: your choices, each team's
// goal and note with its required members (brief, notes page, note, whole model list, "only these" mark), which
// teams work in which step, the steps and their stops, the cycle, and the playbook contents page with its entry
// for Sova's commands. No member prompt: each team's coordinator writes its members' instructions. Pure.
import { runInstruction } from "../../shared/playbook-run";
import type { PlanMember, PlanModel, PlaybookPlan } from "./plan";

export interface ContentsSection {
  name: string;
  /** The section's line in the contents page. */
  line: string;
  /** Where the run can read it: an absolute path. */
  file: string;
}

const q = (s: string) => s.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

/** A one-line goal or brief as a sentence: a full stop added when it ends without one. */
const sentence = (s: string): string => (/[.!?…:]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

const modelWords = (m: PlanModel): string => `${m.model}${m.effort ? ` (${m.effort})` : ""}${m.why ? ` [can't run now: ${m.why}]` : ""}`;

export function runBlock(plan: PlaybookPlan, folder: string, opts: { contents: ContentsSection[]; sovaScript: string }): string {
  const lines: string[] = [`<run id="${plan.runId}" playbook="${q(plan.playbook.id)}" revision="${plan.revision}" folder="${q(folder)}">`];
  lines.push(`Run folder: ${folder} (plan.json, the contents pages in know-how/). Write the run's output where the playbook says, never in this folder.`);

  lines.push("", "Your choices (the user's, frozen at Start):");
  if (!plan.choices.length) lines.push("- (none)");
  for (const c of plan.choices) lines.push(`- ${c.label} [${c.id}]: ${c.text}`);
  if (plan.text) lines.push("", `The user's words with the playbook: ${plan.text}`);

  lines.push(
    "",
    "Teams. You run on this chat's own model. Create each team with team_create when its first step begins: give it the goal as its objective and write each member's instructions yourself from the goal, its brief and its notes page (read that with playbook_read). Sova adds a coordinator and a monitor to every team. Each team must have the members listed; it adds anyone else its goal needs. Start each member on its first model that can run.",
  );
  if (!plan.teams.length) lines.push("- (none: you do every step yourself)");
  for (const t of plan.teams) {
    lines.push(`- Team ${t.label} [${t.id}], working in ${t.steps.length ? t.steps.join(", ") : "no step"}. Goal: ${sentence(t.goal)}${t.note ? ` The user's note for the team: ${t.note}` : ""}`);
    const members = t.members.map((id) => plan.members.find((m) => m.id === id)).filter((m): m is PlanMember => !!m);
    if (!members.length) lines.push("  Required members: none; it picks its own.");
    for (const m of members) {
      const list = m.chain.map(modelWords).join(" → ") || "(none named: the profile's model for its kind of work, then this chat's model)";
      const many = m.items?.length ? ` ×${m.count}, one per item (${m.items.join("; ")})` : m.count > 1 ? ` ×${m.count}` : "";
      const parts = [
        `  - ${m.label} [${m.id}]${many}${m.kind ? `, kind ${m.kind}` : ""}: ${sentence(m.brief)}`,
        m.notes ? `Notes page: ${m.notes}.` : "",
        `Models in order: ${list}.`,
        m.only ? "Only these models: if none of them can run, stop and ask the user; never pick another." : "When the list runs out, use the kind's model from the user's profile, then this chat's model.",
        m.reason ? `Starts on entry ${m.use + 1}: ${m.reason}.` : "",
        m.sees === "blind" ? "Blind: never tell it which arm or version produced what it judges." : "",
        m.fresh === "cycle" ? "Start it anew each cycle." : "",
        m.note ? `The user's note for it: ${m.note}` : "",
      ];
      lines.push(parts.filter(Boolean).join(" "));
    }
  }

  lines.push("", "Steps, in order:");
  plan.steps.forEach((s, i) => {
    const who = s.teams.length ? s.teams.map((id) => `team ${plan.teams.find((t) => t.id === id)?.label ?? id}`).join(" and ") : "you alone";
    const bits = [
      `${i + 1}. ${s.label} [${s.id}]${s.cycle ? ` (in cycle "${s.cycle}")` : ""}: ${who}.`,
      s.goal ? `Goal: ${sentence(s.goal)}` : "",
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
  lines.push("- When a model is refused or stops working, move that member to the next model on its list and say so in your next message (from, to, why). An \"only these models\" member whose list runs out: stop and wait for the user.");
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
