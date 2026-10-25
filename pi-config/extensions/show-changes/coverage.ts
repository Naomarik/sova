/**
 * The steps checked against the real diff, before anything opens: which step each hunk goes to,
 * which hunks no step names and which refs name nothing, and the refusal the model reads.
 *
 * The matching mirrors Sova's viewer (src/lib/changes-steps.ts `refMatches` / `stepsFromAgent`):
 * a ref by path alone takes every hunk of that file (the new path, or a rename's old one), a start
 * names the hunk whose range holds it on that side, and the first step naming a hunk wins. A file
 * with no hunks to name (binary, too large, or a rename, mode change or empty file with no line
 * changes) is one unit that any ref to it names. A step whose refs name only units earlier steps
 * already hold is refused (the viewer shows it empty, "taken"). Sova pins
 * both to the same results (src/lib/show-changes-coverage.test.ts), so this file imports nothing.
 */

/** One hunk of the diff, from its `@@ -oldStart,oldLines +newStart,newLines @@` header. */
export interface DiffHunk {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	/** The hunk's first added or removed line, sign included, cut to ~80 characters. */
	firstChanged: string;
}

/** One file of the diff. `hunks` null: binary or too large; null or empty, the whole file is one unit. */
export interface DiffFileHunks {
	path: string;
	oldPath?: string;
	hunks: DiffHunk[] | null;
}

export interface StepRef {
	path: string;
	oldStart?: number;
	newStart?: number;
}

/** A unit no step names: a hunk, or a whole file (`hunk` null). */
export interface Unplaced {
	path: string;
	hunk: DiffHunk | null;
	/** For a whole-file unit: binary or too large (`hunks` null), else no line changes. */
	whole?: "binary" | "no-lines";
}

/** A step that names units but takes none: every one is held by an earlier step. */
export interface Shadowed {
	/** 1-based step number. */
	step: number;
	/** 1-based numbers of the earlier steps holding what it names, ascending. */
	heldBy: number[];
}

export interface BadRef {
	/** 1-based step number. */
	step: number;
	ref: StepRef;
	/** The file the ref's path names, when it is in the diff (its hunks then help fix the ref). */
	file?: DiffFileHunks;
}

export interface Placement {
	/** Units in the diff: hunks, plus one per whole-file unit. */
	units: number;
	/** Per file (same order as the input), per unit (a whole-file unit is index 0): the 0-based step that took it, or -1. */
	owner: number[][];
	unplaced: Unplaced[];
	badRefs: BadRef[];
	shadowed: Shadowed[];
}

/** Does a ref name this hunk: the header's own number, else a line inside its range (Sova's refMatches). */
export function refMatches(ref: StepRef, h: DiffHunk): boolean {
	const inside = (n: number, start: number, count: number) => n === start || (n >= start && n < start + Math.max(count, 1));
	if (ref.newStart !== undefined) return inside(ref.newStart, h.newStart, h.newLines);
	if (ref.oldStart !== undefined) return inside(ref.oldStart, h.oldStart, h.oldLines);
	return true;
}

/** A file with no hunks to name is one whole-file unit. */
const isWhole = (f: DiffFileHunks) => f.hunks === null || f.hunks.length === 0;
const unitCount = (f: DiffFileHunks) => (isWhole(f) ? 1 : f.hunks!.length);

/** Place every unit with the first step naming it; list what nobody names and refs naming nothing. */
export function placeSteps(steps: readonly { hunks: readonly StepRef[] }[], files: readonly DiffFileHunks[]): Placement {
	const owner = files.map((f) => new Array<number>(unitCount(f)).fill(-1));
	const byPath = new Map<string, number>();
	files.forEach((f, i) => {
		byPath.set(f.path, i);
		if (f.oldPath) byPath.set(f.oldPath, i);
	});
	const badRefs: BadRef[] = [];
	const shadowed: Shadowed[] = [];
	steps.forEach((s, si) => {
		let took = 0;
		const heldBy = new Set<number>();
		for (const ref of s.hunks) {
			const fi = byPath.get(ref.path);
			const file = fi === undefined ? undefined : files[fi]!;
			let named = 0;
			if (file) {
				const mine = owner[fi!]!;
				const whole = isWhole(file);
				for (let u = 0; u < mine.length; u++) {
					if (!whole && !refMatches(ref, file.hunks![u]!)) continue;
					named++;
					if (mine[u] === -1) {
						mine[u] = si;
						took++;
					} else if (mine[u] !== si) heldBy.add(mine[u]! + 1);
				}
			}
			if (named === 0) badRefs.push({ step: si + 1, ref, ...(file ? { file } : {}) });
		}
		if (took === 0 && heldBy.size > 0) shadowed.push({ step: si + 1, heldBy: [...heldBy].sort((a, b) => a - b) });
	});
	const unplaced: Unplaced[] = [];
	files.forEach((f, fi) =>
		owner[fi]!.forEach((o, u) => {
			if (o !== -1) return;
			if (isWhole(f)) unplaced.push({ path: f.path, hunk: null, whole: f.hunks === null ? "binary" : "no-lines" });
			else unplaced.push({ path: f.path, hunk: f.hunks![u]! });
		}),
	);
	return { units: owner.reduce((n, o) => n + o.length, 0), owner, unplaced, badRefs, shadowed };
}

/** Past this many units the refusal lists files with counts instead of hunks. */
export const LIST_HUNKS_MAX = 150;
/** The refusal's size cap, in characters. */
export const REFUSAL_MAX = 12_000;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const hunkLine = (h: DiffHunk) => `  @@ +${h.newStart},${h.newLines}: ${h.firstChanged}`;
const WHOLE = { binary: "  (binary or too large: one unit, name it by path)", "no-lines": "  (renamed, mode change or empty: no line changes, one unit, name it by path)" };
const stepList = (ns: readonly number[]) => (ns.length === 1 ? `step ${ns[0]}` : `steps ${ns.slice(0, -1).join(", ")} and ${ns.at(-1)}`);

/** `units` grouped by file, in first-seen order: every hunk, or when too many, files with counts. */
function listing(units: readonly Unplaced[], room: number): string[] {
	const byFile = new Map<string, Unplaced[]>();
	for (const u of units) byFile.set(u.path, [...(byFile.get(u.path) ?? []), u]);
	const fit = (lines: string[]) => lines.join("\n").length <= room;
	if (units.length <= LIST_HUNKS_MAX) {
		const lines = [...byFile].flatMap(([path, us]) => [path, ...us.map((u) => (u.hunk ? hunkLine(u.hunk) : WHOLE[u.whole ?? "binary"]))]);
		if (fit(lines)) return lines;
	}
	const counts = [...byFile].map(([path, us]) => `${path} (${us[0]!.hunk === null ? "whole file" : plural(us.length, "hunk")})`);
	const lines = ["Too many to list one by one; by file (naming a file by path alone places all its hunks):"];
	let used = lines[0]!.length;
	for (let i = 0; i < counts.length; i++) {
		if (used + counts[i]!.length + 40 > room) {
			lines.push(`… and ${counts.length - i} more files`);
			break;
		}
		lines.push(counts[i]!);
		used += counts[i]!.length + 1;
	}
	return lines;
}

function refText(r: StepRef): string {
	return `{path: ${JSON.stringify(r.path)}${r.newStart !== undefined ? `, newStart: ${r.newStart}` : ""}${r.oldStart !== undefined ? `, oldStart: ${r.oldStart}` : ""}}`;
}

function badRefLine(b: BadRef): string {
	const why = !b.file
		? "that file is not in this diff"
		: isWhole(b.file)
			? "that file is one unit"
			: `${b.ref.newStart !== undefined ? "new" : "old"}-side line inside none of its hunks (${b.file
					.hunks!.map((h) => (b.ref.newStart !== undefined ? `+${h.newStart},${h.newLines}` : `-${h.oldStart},${h.oldLines}`))
					.join(" ")})`;
	return `  step ${b.step}: ${refText(b.ref)}: ${why}`;
}

/**
 * The refusal for a call whose steps don't place the whole diff, or undefined when it may open:
 * no steps and at most one unit, or steps placing every unit, every ref naming one and every step
 * taking at least one (a step naming only what earlier steps hold would open empty).
 */
export function coverageRefusal(steps: readonly { hunks: readonly StepRef[] }[] | undefined, files: readonly DiffFileHunks[]): string | undefined {
	const all = placeSteps([], files);
	if (all.units <= 1 && !steps?.length) return undefined;
	if (!steps?.length) {
		const head = [
			`Nothing was shown: this diff has ${plural(all.units, "hunk")} in ${plural(files.filter((f) => unitCount(f) > 0).length, "file")} and the call sent no steps.`,
			"Resend show_changes with steps that place every hunk below. If the change is one idea, send one step naming every file by path alone ({path} with no start takes all of a file's hunks).",
			"Hunks (path, then @@ +newStart,newLines: first changed line):",
		];
		return head.concat(listing(all.unplaced, REFUSAL_MAX - head.join("\n").length - 200)).join("\n");
	}
	const p = placeSteps(steps, files);
	if (p.units === 0 || (p.unplaced.length === 0 && p.badRefs.length === 0 && p.shadowed.length === 0)) return undefined;
	const problems = [
		...(p.unplaced.length ? [`${p.unplaced.length} of ${plural(p.units, "hunk")} placed by no step`] : []),
		...(p.badRefs.length ? [`${plural(p.badRefs.length, "ref")} naming no hunk`] : []),
		...(p.shadowed.length ? [`${plural(p.shadowed.length, "step")} naming only hunks earlier steps hold`] : []),
	];
	const lines = [`Nothing was shown: the steps leave ${problems.join(" and ")}. Every hunk must be in exactly one step (the first naming it).`];
	lines.push("Resend show_changes with the same steps, fixed: add a ref for each hunk below to the step it belongs to (or a new step); {path} alone takes all of a file's hunks. newStart is any new-side line inside the hunk.");
	const shadowText = p.shadowed.map((s) => `  step ${s.step} names only hunks earlier steps already hold (${stepList(s.heldBy)})`).join("\n");
	const bad = p.badRefs.map(badRefLine);
	let badText = bad.join("\n");
	if (badText.length > 3000) {
		const keep = bad.slice(0, 20);
		badText = [...keep, `  … and ${bad.length - keep.length} more`].join("\n");
	}
	if (p.unplaced.length) {
		lines.push("Placed by no step (path, then @@ +newStart,newLines: first changed line):");
		lines.push(...listing(p.unplaced, REFUSAL_MAX - lines.join("\n").length - badText.length - shadowText.length - 300));
	}
	if (bad.length) lines.push("Refs naming no hunk (fix or remove them):", badText);
	if (p.shadowed.length) lines.push("Steps that would open empty (merge each into the step holding its hunks, or name the hunks it should hold):", shadowText);
	return lines.join("\n");
}
