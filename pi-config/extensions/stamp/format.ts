/**
 * The one timestamp formatter shared by the `stamp` TUI extension and Sova's web UI.
 *
 * Imports nothing — no pi runtime, no node builtins — so Vite can bundle it for the browser and
 * pi can load it with plain type stripping. Every function takes an ISO string or an epoch in ms,
 * and an optional `now` (ms) for tests. An unreadable time formats as "".
 */

export type TimeInput = string | number;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function toMs(t: TimeInput): number {
	return typeof t === "number" ? t : Date.parse(t);
}

/** 12-hour clock in local time: "1:43 PM", "12:05 AM". */
export function clockTime(t: TimeInput): string {
	const ms = toMs(t);
	if (!Number.isFinite(ms)) return "";
	const d = new Date(ms);
	const h = d.getHours();
	return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** The clock, prefixed with `Mar 4 ` when the day isn't today: "1:43 PM", "Mar 4 1:43 PM". */
export function stampTime(t: TimeInput, now = Date.now()): string {
	const ms = toMs(t);
	if (!Number.isFinite(ms)) return "";
	const d = new Date(ms);
	const sameDay = d.toDateString() === new Date(now).toDateString();
	return `${sameDay ? "" : `${MONTHS[d.getMonth()]} ${d.getDate()} `}${clockTime(ms)}`;
}

/** The relative form and whether it is still an age (false once it has become a date). */
function relative(ms: number, now: number): { text: string; age: boolean } {
	const sec = Math.max(0, Math.round((now - ms) / 1000));
	if (sec < 45) return { text: "just now", age: true };
	const min = Math.round(sec / 60);
	if (min < 60) return { text: `${min}m ago`, age: true };
	const hr = Math.round(min / 60);
	if (hr < 24) return { text: `${hr}h ago`, age: true };
	const day = Math.round(hr / 24);
	if (day === 1) return { text: "yesterday", age: true };
	if (day < 7) return { text: `${day}d ago`, age: true };
	const d = new Date(ms);
	const sameYear = d.getFullYear() === new Date(now).getFullYear();
	return { text: `${MONTHS[d.getMonth()]} ${d.getDate()}${sameYear ? "" : `, ${d.getFullYear()}`}`, age: false };
}

/** "just now" · "5m ago" · "2h ago" · "yesterday" · "3d ago", then "Mar 4" past 7 days
    ("Mar 4, 2024" in another year). A future time (clock skew) reads "just now". */
export function relativeTime(t: TimeInput, now = Date.now()): string {
	const ms = toMs(t);
	return Number.isFinite(ms) ? relative(ms, now).text : "";
}

/** The relative form while it is an age ("5m ago", "yesterday"); "" once it would only repeat
    the date the stamp already shows (past 7 days). */
export function agoTime(t: TimeInput, now = Date.now()): string {
	const ms = toMs(t);
	if (!Number.isFinite(ms)) return "";
	const r = relative(ms, now);
	return r.age ? r.text : "";
}

/** A message stamp: "1:43 PM · 5m ago", "Mar 4 1:43 PM · 3d ago"; older, the stamp alone. */
export function stampAgo(t: TimeInput, now = Date.now()): string {
	const stamp = stampTime(t, now);
	const ago = agoTime(t, now);
	return ago ? `${stamp} · ${ago}` : stamp;
}
