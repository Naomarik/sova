import { test } from "node:test";
import assert from "node:assert/strict";
import type { InboxItem } from "./inbox.ts";
import { endReason, groupReturns, returnNoticeText, returnTarget } from "./inbox-lifecycle.ts";

const item = (id: string, from: InboxItem["from"], over: Partial<InboxItem> = {}): InboxItem => ({
	id, teamId: "team_01", from, to: { role: "dev", workerId: "ag_02" }, kind: "message", urgent: false,
	subject: `subject ${id}`, body: `subject ${id}`, sentAt: 1000 + Number.parseInt(id.slice(2), 36), status: "new", ...over,
});

test("inbox lifecycle: returned items go back to their member sender; Sova's and the main thread's apart", () => {
	const qa = { role: "qa", workerId: "ag_03" };
	const items = [
		item("i_3", qa),
		item("i_1", { role: "Sova", workerId: "parent" }, { kind: "report", urgent: true }),
		item("i_2", { role: "main thread", workerId: "parent" }, { kind: "notice" }),
		item("i_4", qa, { body: "subject i_4\nmore detail" }),
	];
	assert.deepEqual(returnTarget(items[0]), { kind: "member", to: qa });
	const groups = groupReturns(items);
	assert.deepEqual(groups.map((g) => [g.target.kind, g.items.map((i) => i.id)]), [["sova", ["i_1"]], ["main", ["i_2"]], ["member", ["i_3", "i_4"]]]);
	const text = returnNoticeText({ role: "dev", workerId: "ag_02" }, "team_01", endReason({ status: "killed" }), groups[2].items);
	assert.match(text, /^\[Not addressed: 2 item\(s\) returned from dev \(ag_02\), team_01 — it was stopped, with no successor\]\n- i_3 message sent .* — subject i_3\n- i_4 message sent .* — subject i_4\n\ni_4:\nsubject i_4\nmore detail\n\nSend them again to another member, or ask the main thread to bring dev back with agent_resume ag_02\.$/);
	assert.match(returnNoticeText({ role: "dev", workerId: "ag_02" }, "team_01", "it failed", groups[0].items, true), /- i_1 report \(urgent\) sent .*\nThese were Sova's notices to dev/);
	assert.equal(endReason({ ejected: true, status: "killed" }), "it was ejected");
	assert.equal(endReason({ restored: true }), "its process had ended when the main chat restarted");
	assert.equal(endReason({ status: "error" }), "it failed");
});

test("inbox lifecycle: a return notice stays within the 8,000-character item limit", () => {
	const qa = { role: "qa", workerId: "ag_03" };
	const big = Array.from({ length: 5 }, (_, n) => item(`i_${n + 1}`, qa, { body: `head\n${"x".repeat(7000)}` }));
	const text = returnNoticeText({ role: "dev", workerId: "ag_02" }, "team_01", "it ended", big);
	assert.ok(text.length <= 8000);
	assert.match(text, /- i_5 message/);
	assert.match(text, /Other bodies not shown/);
});
