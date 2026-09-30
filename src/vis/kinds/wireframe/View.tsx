/**
 * `vis wireframe` view: each screen a phone or desktop frame of DOM blocks (flex and grid), in one
 * sideways strip. The only SVG is the chart glyphs and one overlay of wireflow arrows, measured
 * from the laid-out chips after mount and on every resize. A block that opens another screen
 * carries a "→ 2 Name" chip; tapping it scrolls that screen into view. layout.ts's fitStrip decides
 * how it fits the pane: whole, scaled whole (several screens, to no less than 3/4), or scrolling between
 * screens, each frame scaled to the pane if it is wider (a frame never pans inside itself). While it
 * scrolls, a row of screen buttons above it, with previous and next at its end, does the same as a
 * swipe, so the swipe is never the only way.
 */
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { emphasisMap } from "../../core/emphasis";
import type { Emphasis } from "../../core/grammar";
import { looksLikePath } from "../../core/text";
import { EmBadge } from "../../emphasis";
import { visIcon } from "../../icons";
import type { ViewProps } from "../../types";
import { wireframeIcon } from "./icons";
import { FRAME_GAP, fitStrip } from "./layout";
import type { WBlock, WireframeSpec, WScreen } from "./parse";
import "./wireframe.css";

const OVERLAYS = new Set(["modal", "sheet", "toast"]);
/** Header icons that sit left of the title; the rest sit at its right. */
const LEADING = /^(back|menu|←|hamburger|arrow-left)$/i;
/** Blocks in a heading that sit at its right. */
const HEADING_END = new Set(["button", "link", "icon"]);
/** In an item, these lead; the rest trail. */
const ITEM_LEAD = new Set(["avatar", "icon", "image", "checkbox", "radio"]);

type Arrow = { d: string; head: string };
/** How far into the gap after a frame a routed arrow turns, and the lane above the frames (the strip's top padding). */
const LANE_OUT = 10;
const LANE_Y = 7;
/** Routed arrows in one gap sit this far apart, so two never read as one path. */
const LANE_STEP = 6;
/** A scrolling strip narrower than this shows about one screen at a time: no arrows then, the chips carry the targets. */
const ARROWS_MIN = 600;

/** A polyline through `pts` with its corners rounded. */
function rounded(pts: [number, number][], r = 6): string {
  let d = `M${pts[0]![0]} ${pts[0]![1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1]!;
    const [x, y] = pts[i]!;
    const [nx, ny] = pts[i + 1]!;
    const k1 = Math.min(r, Math.hypot(x - px, y - py) / 2);
    const k2 = Math.min(r, Math.hypot(nx - x, ny - y) / 2);
    const ux = Math.sign(x - px), uy = Math.sign(y - py), vx = Math.sign(nx - x), vy = Math.sign(ny - y);
    d += ` L${x - ux * k1} ${y - uy * k1} Q${x} ${y} ${x + vx * k2} ${y + vy * k2}`;
  }
  const [lx, ly] = pts[pts.length - 1]!;
  return `${d} L${lx} ${ly}`;
}

export default function WireframeView(props: ViewProps<WireframeSpec>) {
  const spec = props.spec;
  const em = emphasisMap(spec);
  const many = spec.screens.length > 1;
  const nameOf = (i: number) => spec.screens[i]?.name ?? `Screen ${i + 1}`;
  let scroller!: HTMLDivElement;
  let navRow: HTMLDivElement | undefined;
  let strip!: HTMLDivElement;
  const shots: HTMLElement[] = [];
  const [arrows, setArrows] = createSignal<Arrow[]>([]);
  const [overflow, setOverflow] = createSignal(false);
  const [current, setCurrent] = createSignal(0);
  /** The screen buttons' row has no room for the current one's name (under about 6ch): every button is its number. */
  const [numbersOnly, setNumbersOnly] = createSignal(false);
  /** The pane's width (the scroller's), once laid out: what fitStrip fits to. */
  const [width, setWidth] = createSignal(0);
  const fit = createMemo(() => (width() > 0 ? fitStrip(spec, width()) : undefined));

  /** Where the strip scrolls to show screen `i` from its start. */
  const leftOf = (shot: HTMLElement) => Math.max(0, scroller.scrollLeft + shot.getBoundingClientRect().left - scroller.getBoundingClientRect().left - FRAME_GAP / 4);
  const goTo = (i: number) => {
    const shot = shots[i];
    if (!shot) return;
    const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Already whole in view (the last screens of a wide strip): it only becomes current.
    asked = { i, seen: whole(shot) };
    if (!asked.seen) scroller.scrollTo({ left: leftOf(shot), behavior: still ? "auto" : "smooth" });
    setCurrent(i);
    shot.focus({ preventScroll: true });
  };
  /** The screen the reader asked for (a button, a chip): current while it's on its way and while it stays whole in view. */
  let asked: { i: number; seen: boolean } | null = null;
  const whole = (shot: HTMLElement) => {
    const r = shot.getBoundingClientRect();
    const v = scroller.getBoundingClientRect();
    return r.left >= v.left - 1 && r.right <= v.right + 1;
  };

  /**
   * Arrows from each chip to its screen, in the strip's own coordinates. To the next screen: a curve
   * across the gap into its near edge. Back, or past a screen: out through the gap after its own
   * frame, along the lane above the frames, and down the gap beside the target, so it never crosses
   * a screen's content.
   */
  const measure = () => {
    if (scroller.clientWidth !== width()) setWidth(scroller.clientWidth);
    setOverflow(scroller.scrollWidth > scroller.clientWidth + 1);
    // Frames narrow with the pane: keep the screen the reader was on in view.
    if (current() > 0 && shots[current()]) scroller.scrollLeft = leftOf(shots[current()]!);
    if (overflow() && scroller.clientWidth < ARROWS_MIN) {
      setArrows([]);
      return;
    }
    // In the strip's own units: a scaled strip's boxes are measured scaled.
    const k = fit()?.strip ?? 1;
    const box = strip.getBoundingClientRect();
    const rel = (r: DOMRect) => ({ l: (r.left - box.left) / k, r: (r.right - box.left) / k, t: (r.top - box.top) / k, b: (r.bottom - box.top) / k });
    const boxW = box.width / k;
    type Leg = { to: number; from: number; a: ReturnType<typeof rel>; t: ReturnType<typeof rel>; src: ReturnType<typeof rel>; side: "l" | "r"; y2: number };
    const legs: Leg[] = [];
    for (const chip of strip.querySelectorAll<HTMLElement>("[data-wf-to]")) {
      const to = Number(chip.dataset.wfTo);
      const from = shots.findIndex((s) => s.contains(chip));
      const tf = shots[to]?.querySelector(".vis-wf-frame");
      const sf = shots[from]?.querySelector(".vis-wf-frame");
      if (!tf || !sf) continue;
      const a = rel(chip.getBoundingClientRect());
      const t = rel(tf.getBoundingClientRect());
      const y1 = (a.t + a.b) / 2;
      // Into the next screen, level with the chip where it can; otherwise near the target's top.
      const y2 = to === from + 1 ? Math.min(Math.max(y1, t.t + 28), t.b - 28) : t.t + 28;
      legs.push({ to, from, a, t, src: rel(sf.getBoundingClientRect()), side: to < from ? "r" : "l", y2 });
    }
    // Several arrows into one side of a screen: their ends spread evenly down that edge, in the order they start.
    const groups = new Map<string, Leg[]>();
    for (const g of legs) groups.set(`${g.to}${g.side}`, [...(groups.get(`${g.to}${g.side}`) ?? []), g]);
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      g.sort((p, q) => p.a.t - q.a.t);
      const top = g[0]!.t.t + 28;
      const span = Math.max(0, g[0]!.t.b - 28 - top);
      g.forEach((leg, i) => (leg.y2 = top + (span * i) / (g.length - 1)));
    }
    const out: Arrow[] = [];
    let routed = 0;
    for (const { to, from, a, t, src, side, y2 } of legs) {
      const y1 = (a.t + a.b) / 2;
      const x1 = a.r;
      if (to === from + 1) {
        const dx = Math.max(20, (t.l - x1) / 2);
        const end = t.l - 7;
        out.push({ d: `M${x1} ${y1} C${x1 + dx} ${y1} ${end - dx} ${y2} ${end} ${y2}`, head: `M${t.l} ${y2} l-8 -4.5 v9 z` });
        continue;
      }
      const back = side === "r";
      // Each routed arrow its own track: in the gaps 6px apart (5 fit in 40px), in the lane 2.5px apart.
      const k = routed++ % 5;
      const off = LANE_STEP * k;
      const laneY = LANE_Y - 5 + 2.5 * k;
      const xa = Math.min(src.r + LANE_OUT + off, boxW - 3);
      const xb = back ? t.r + LANE_OUT + off : t.l - LANE_OUT - off;
      const end = back ? t.r + 7 : t.l - 7;
      out.push({ d: rounded([[x1, y1], [xa, y1], [xa, laneY], [xb, laneY], [xb, y2], [end, y2]]), head: back ? `M${t.r} ${y2} l8 -4.5 v9 z` : `M${t.l} ${y2} l-8 -4.5 v9 z` });
    }
    setArrows(out);
  };
  /** The reader takes over (a wheel, a touch, a press, a key): a screen asked for no longer holds "current". */
  const letGo = () => {
    asked = null;
  };
  let settle: ReturnType<typeof setTimeout> | undefined;
  const onScroll = () => {
    // Fallback: a request whose scroll was cut short before its screen was whole ends once scrolling stops.
    clearTimeout(settle);
    settle = setTimeout(() => {
      if (asked && !asked.seen) {
        asked = null;
        onScroll();
      }
    }, 1000);
    if (asked) {
      const shot = shots[asked.i];
      if (shot && whole(shot)) asked.seen = true;
      else if (asked.seen || !shot) asked = null;
      if (asked) return setCurrent(asked.i);
    }
    // Scrolled to the end: the last screen, which may never reach the start. Only after a real scroll of a strip that
    // scrolls: while it is still laying out (no width yet) "at the end" is also "at the start". Otherwise the first screen from the start.
    const scrolls = scroller.scrollWidth > scroller.clientWidth + 1;
    if (scrolls && scroller.scrollLeft > 8 && scroller.scrollLeft + scroller.clientWidth >= scroller.scrollWidth - 2) return setCurrent(shots.length - 1);
    const x = scroller.scrollLeft + FRAME_GAP;
    let at = 0;
    shots.forEach((s, i) => {
      if (s.offsetLeft <= x) at = i;
    });
    setCurrent(at);
  };

  // The row of screen buttons is one line that scrolls: keep the current one in it.
  createEffect(() => {
    const b = navRow?.children[current()] as HTMLElement | undefined;
    if (b && navRow) navRow.scrollLeft = Math.max(0, Math.min(navRow.scrollLeft, b.offsetLeft - navRow.offsetLeft - 4), b.offsetLeft - navRow.offsetLeft + b.offsetWidth - navRow.clientWidth + 4);
  });

  // Room for the current button's name: the row less the other buttons (numbers on a phone), the gaps and its own number.
  // Only where the others already hide their names (wireframe.css); wider, every button is named and the row scrolls.
  const fitNames = () => {
    if (!navRow) return;
    const buttons = [...navRow.children] as HTMLElement[];
    const other = buttons.find((b) => b.getAttribute("aria-current") !== "true");
    const name = other?.querySelector<HTMLElement>(".vis-wf-nav-name");
    if (!other || !name || getComputedStyle(name).display !== "none") return setNumbersOnly(false);
    const gap = parseFloat(getComputedStyle(navRow).columnGap) || 0;
    // A number-only button, the current one's width without its name; at least 44px (numbers-only may narrow them, wireframe.css).
    const own = Math.max(other.offsetWidth, 44);
    const room = navRow.clientWidth - buttons.length * own - (buttons.length - 1) * gap - gap;
    setNumbersOnly(room < 3 * parseFloat(getComputedStyle(name).fontSize)); // ~6ch
  };
  createEffect(() => {
    width();
    if (overflow()) queueMicrotask(fitNames);
  });

  onMount(() => {
    measure();
    const ro = new ResizeObserver(() => measure());
    ro.observe(scroller);
    ro.observe(strip);
    onCleanup(() => {
      ro.disconnect();
      clearTimeout(settle);
    });
  });

  const ph = (n: number) => (
    <span class="vis-wf-ph" aria-hidden="true">
      <For each={Array.from({ length: n })}>{() => <i />}</For>
    </span>
  );
  const Icon = (p: { name?: string; class?: string }) => {
    const file = wireframeIcon(p.name);
    return file ? <span class={`icon icon-sm ${p.class ?? ""}`} style={{ "--icon": `url("${visIcon(file)}")` }} aria-hidden="true" /> : <span class={`vis-wf-dot ${p.class ?? ""}`} aria-hidden="true" />;
  };
  const Txt = (p: { s: string | undefined; class?: string }) => (
    <Show when={p.s}>
      <span class={p.class} classList={{ "vis-mono": looksLikePath(p.s!) }}>
        <Breakable s={p.s!} />
      </span>
    </Show>
  );

  /** The "→ 2 Name" chip of a block or screen that opens another. */
  const Go = (p: { from: { to?: number; toName?: string } }) => (
    <>
      <Show when={p.from.to !== undefined}>
        <button type="button" class="vis-wf-go" data-wf-to={p.from.to} aria-label={`opens screen ${p.from.to! + 1}, ${nameOf(p.from.to!)}`} onClick={() => goTo(p.from.to!)}>
          → {p.from.to! + 1}
          <span class="vis-wf-go-name">{nameOf(p.from.to!)}</span>
        </button>
      </Show>
      <Show when={p.from.to === undefined && p.from.toName}>
        <span class="vis-wf-go vis-wf-go-off" title={`opens ${p.from.toName}, not drawn here`}>
          → <span class="vis-wf-go-name">{p.from.toName}</span>
        </span>
      </Show>
    </>
  );

  const cls = (b: WBlock, base: string, e: Emphasis | undefined) =>
    // A mark rings the block in its own tone; the block keeps its own (an accent button stays filled).
    `${base} vis-tone-${b.tone ?? "none"}${e ? ` vis-wf-em vis-wf-em-${e.tone}` : ""}${b.wide ? " vis-wf-wide" : ""}${b.on ? " vis-wf-on" : ""}`;

  /** `bare`: without its chip, which the caller places. */
  function Block(p: { b: WBlock; bare?: boolean }): JSX.Element {
    const b = p.b;
    const e = em.get(b.key);
    const t = b.texts;
    const badge = () => <EmBadge e={e} />;
    const kids = (bs: WBlock[] = b.children) => <For each={bs}>{(c) => <Block b={c} />}</For>;
    const c = (base: string) => cls(b, base, e);
    switch (b.type) {
      case "header": {
        const lead = b.children.filter((k) => k.type === "icon" && LEADING.test(k.texts[0] ?? ""));
        const trail = b.children.filter((k) => !lead.includes(k));
        return (
          <div class={c("vis-wf-header")}>
            {/* A leading icon's chip goes after the title, never between the icon and it. */}
            <For each={lead}>{(k) => <Block b={k} bare />}</For>
            <span class="vis-wf-header-title">
              <Txt s={t[0]} />
              <Txt s={t[1]} class="vis-wf-sub" />
            </span>
            <For each={lead}>{(k) => <Go from={k} />}</For>
            <Show when={trail.length}>
              <span class="vis-wf-header-end">{kids(trail)}</span>
            </Show>
            <Go from={b} />
            {badge()}
          </div>
        );
      }
      case "tabs":
      case "tabbar":
        return (
          <div class={c(`vis-wf-${b.type}`)}>
            <For each={b.items ?? []}>
              {(s, i) => (
                <span classList={{ "vis-wf-cur": i() === b.current }}>
                  <Show when={b.type === "tabbar"}>
                    <Icon name={s} class="vis-wf-tab-icon" />
                  </Show>
                  <span class="vis-wf-tab-label">{s}</span>
                </span>
              )}
            </For>
            <Go from={b} />
            {badge()}
          </div>
        );
      case "footer":
        return (
          <div class={c("vis-wf-footer")}>
            <Show when={t.length}>
              <span>{t.join(" · ")}</span>
            </Show>
            {kids()}
            <Go from={b} />
            {badge()}
          </div>
        );
      case "sidebar":
      case "col":
      case "modal":
      case "sheet":
        return (
          <div class={c(`vis-wf-${b.type}`)}>
            <Show when={t[0]}>
              <div class="vis-wf-title">
                <Txt s={t[0]} />
                <Go from={b} />
              </div>
            </Show>
            <Show when={t[1]}>
              <div class="vis-wf-sub">{t.slice(1).join(" · ")}</div>
            </Show>
            <Show when={!t[0]}>
              <Go from={b} />
            </Show>
            {kids()}
            {badge()}
          </div>
        );
      case "row":
        return (
          <div class={c("vis-wf-row")}>
            {kids()}
            {/* Beside the blocks while each keeps about 12ch, else on a line of its own under them (wireframe.css). */}
            <Show when={b.to !== undefined || b.toName}>
              <span class="vis-wf-row-go">
                <Go from={b} />
              </span>
            </Show>
            {badge()}
          </div>
        );
      case "grid":
        return (
          <div class={c("vis-wf-grid")}>
            {kids()}
            <Go from={b} />
            {badge()}
          </div>
        );
      case "card":
        return (
          <div class={c("vis-wf-card")}>
            <Show when={t[0] || b.to !== undefined || b.toName}>
              <div class="vis-wf-title">
                <Txt s={t[0]} />
                <Go from={b} />
              </div>
            </Show>
            <Show when={t[1]}>
              <div class="vis-wf-sub">{t.slice(1).join(" · ")}</div>
            </Show>
            {kids()}
            {badge()}
          </div>
        );
      case "list":
        return (
          <div class={c("vis-wf-list")}>
            <Show when={t[0]}>
              <div class="vis-wf-list-title">{t[0]}</div>
            </Show>
            <For each={b.children}>
              {(k) =>
                k.type === "item" ? (
                  <Block b={k} />
                ) : (
                  <div class="vis-wf-item">
                    <Block b={k} />
                  </div>
                )
              }
            </For>
            <Go from={b} />
            {badge()}
          </div>
        );
      case "item": {
        const lead = b.children.filter((k) => ITEM_LEAD.has(k.type));
        const trail = b.children.filter((k) => !lead.includes(k));
        return (
          <div class={c("vis-wf-item")}>
            {kids(lead)}
            {/* The chip goes under the title and detail, so it never squeezes them. */}
            <span class="vis-wf-item-main">
              <Txt s={t[0]} />
              <Txt s={t[1]} class="vis-wf-sub" />
              <Go from={b} />
            </span>
            <Show when={t[2]}>
              <span class="vis-wf-item-end">{t.slice(2).join(" · ")}</span>
            </Show>
            {/* Its other blocks, one group: beside the text while it keeps about 12ch, else on a line under it. */}
            <Show when={trail.length}>
              <span class="vis-wf-item-trail">{kids(trail)}</span>
            </Show>
            {badge()}
          </div>
        );
      }
      case "table": {
        const cols = b.items?.length ? b.items : ["", "", ""];
        return (
          <div class={c("vis-wf-table")}>
            <table>
              <Show when={cols.some(Boolean)}>
                <thead>
                  <tr>
                    <For each={cols}>{(col) => <th>{col}</th>}</For>
                  </tr>
                </thead>
              </Show>
              <tbody>
                <Show
                  when={b.children.length}
                  fallback={
                    <For each={[0, 1, 2]}>
                      {() => (
                        <tr>
                          <For each={cols}>{() => <td>{ph(1)}</td>}</For>
                        </tr>
                      )}
                    </For>
                  }
                >
                  <For each={b.children}>
                    {(r) => {
                      const re = em.get(r.key);
                      return (
                        <tr class={cls(r, "", re)}>
                          <For each={cols}>
                            {(_, i) => (
                              <td>
                                {r.texts[i()] !== undefined ? <Txt s={r.texts[i()]} /> : ph(1)}
                                <Show when={i() === cols.length - 1}>
                                  <EmBadge e={re} />
                                  {/* A row's own blocks (a badge, a button) and its chip sit under the last cell's text. */}
                                  <Show when={r.children.length || r.to !== undefined || r.toName}>
                                    <span class="vis-wf-cell-blocks">
                                      {kids(r.children)}
                                      <Go from={r} />
                                    </span>
                                  </Show>
                                </Show>
                              </td>
                            )}
                          </For>
                        </tr>
                      );
                    }}
                  </For>
                </Show>
              </tbody>
            </table>
            <Go from={b} />
            {badge()}
          </div>
        );
      }
      case "heading": {
        // A section's controls (a button, a link, an icon) sit at its right, like a header's; the rest under it.
        // Only its first children, before any other block: a later one (or a toggle) is section content.
        const lead = b.children.findIndex((k) => !HEADING_END.has(k.type));
        const end = lead < 0 ? b.children : b.children.slice(0, lead);
        const below = b.children.filter((k) => !end.includes(k));
        return (
          <div class={c("vis-wf-heading")}>
            <div class="vis-wf-heading-text">
              <Txt s={t.join(" ")} />
              <Go from={b} />
              <Show when={end.length}>
                <span class="vis-wf-heading-end">{kids(end)}</span>
              </Show>
            </div>
            {kids(below)}
            {badge()}
          </div>
        );
      }
      case "text":
        return (
          <div class={c("vis-wf-text")}>
            {t.length ? <Txt s={t.join(" ")} /> : ph(3)}
            <Go from={b} />
            {badge()}
          </div>
        );
      case "image":
        return (
          <div class={c("vis-wf-image")}>
            <span class="visually-hidden">image{t[0] ? ":" : ""}</span>
            <svg class="vis-wf-cross" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              <path d="M0 0 L100 100 M100 0 L0 100" />
            </svg>
            <Show when={t[0]}>
              <span class="vis-wf-image-label">{t[0]}</span>
            </Show>
            <Go from={b} />
            {badge()}
          </div>
        );
      case "avatar":
        return (
          // A circle and a pill can't hold a chip: it sits beside them.
          <>
            <span class={c("vis-wf-avatar")} title={t[0]}>
              {initials(t[0])}
              {badge()}
            </span>
            <Go from={b} />
          </>
        );
      case "icon":
        return (
          <span class={c("vis-wf-icon")} title={t[0]}>
            <Icon name={t[0]} />
            <Show when={!p.bare}>
              <Go from={b} />
            </Show>
            {badge()}
          </span>
        );
      case "badge":
        return (
          <>
            <span class={c("vis-wf-badge")}>
              <span class="vis-wf-badge-label">{t.join(" · ")}</span>
              {badge()}
            </span>
            <Go from={b} />
          </>
        );
      case "stat":
        return (
          <div class={c("vis-wf-stat")}>
            <div class="vis-wf-stat-label">{t[0]}</div>
            <div class="vis-wf-stat-value">{t[1] ?? "—"}</div>
            <Show when={t[2]}>
              <div class="vis-wf-stat-delta">{t.slice(2).join(" · ")}</div>
            </Show>
            <Go from={b} />
            {badge()}
          </div>
        );
      case "chart":
        return (
          <div class={c("vis-wf-chart")}>
            <Show when={t[0]}>
              <div class="vis-wf-sub">{t[0]}</div>
            </Show>
            <Chart type={b.chart ?? "bar"} />
            <Go from={b} />
            {badge()}
          </div>
        );
      case "progress":
        return (
          <div class={c("vis-wf-progress")}>
            <span class="vis-wf-progress-head">
              <span>{t[0]}</span>
              <span class="vis-wf-sub">{t[1] ?? `${b.value}%`}</span>
            </span>
            <span class="vis-wf-progress-track">
              <span class="vis-wf-progress-fill" style={{ width: `${b.value ?? 50}%` }} />
            </span>
            <Go from={b} />
            {badge()}
          </div>
        );
      case "button":
        return (
          <span class={c("vis-wf-button")}>
            <span>{t.join(" · ") || "Button"}</span>
            <Go from={b} />
            {badge()}
          </span>
        );
      case "link":
        return (
          <span class={c("vis-wf-link")}>
            <span>{t.join(" ") || "Link"}</span>
            <Go from={b} />
            {badge()}
          </span>
        );
      case "input":
      case "select":
        return (
          <div class={c(`vis-wf-field vis-wf-${b.type}`)}>
            <Show when={t[0]}>
              <span class="vis-wf-field-label">{t[0]}</span>
            </Show>
            <span class="vis-wf-field-box">
              <span class="vis-wf-field-value">{t[1] ?? ""}</span>
              <Show when={b.type === "select"}>
                <Icon name="down" />
              </Show>
            </span>
            <Show when={t[2]}>
              <span class="vis-wf-field-hint">{t.slice(2).join(" · ")}</span>
            </Show>
            <Go from={b} />
            {badge()}
          </div>
        );
      case "search":
        return (
          <div class={c("vis-wf-field vis-wf-search")}>
            <span class="vis-wf-field-box">
              <Icon name="search" />
              <span class="vis-wf-field-value">{t[0] ?? "Search"}</span>
            </span>
            <Go from={b} />
            {badge()}
          </div>
        );
      case "checkbox":
      case "radio":
      case "toggle":
        return (
          <span class={c(`vis-wf-check vis-wf-${b.type}`)}>
            <span class="vis-wf-control" aria-hidden="true" />
            <span class="vis-wf-check-label">{t.join(" ")}</span>
            <span class="visually-hidden">{`, ${b.type}, ${b.on ? "on" : "off"}`}</span>
            <Go from={b} />
            {badge()}
          </span>
        );
      case "empty":
        return (
          <div class={c("vis-wf-empty")}>
            <span class="vis-wf-empty-mark" aria-hidden="true" />
            <b>{t[0] ?? "Nothing here yet"}</b>
            <Show when={t[1]}>
              <span class="vis-wf-sub">{t.slice(1).join(" · ")}</span>
            </Show>
            {kids()}
            <Go from={b} />
            {badge()}
          </div>
        );
      case "loading":
        return (
          <div class={c("vis-wf-loading")}>
            <span class={t[0] ? "vis-wf-sub" : "visually-hidden"}>{t[0] ?? "Loading"}</span>
            {ph(2)}
            {ph(2)}
            <Go from={b} />
            {badge()}
          </div>
        );
      case "alert":
      case "toast":
        return (
          <div class={c(`vis-wf-${b.type}`)}>
            <span>{t.join(" ")}</span>
            <Go from={b} />
            {badge()}
          </div>
        );
      case "divider":
        return (
          <Show when={b.to !== undefined || b.toName || e} fallback={<div class="vis-wf-divider" role="separator" />}>
            <div class={c("vis-wf-divider-row")}>
              <div class="vis-wf-divider" role="separator" />
              <Go from={b} />
              {badge()}
            </div>
          </Show>
        );
      default:
        return (
          <div class={c("vis-wf-box")}>
            <span class="vis-wf-box-tag">{b.tag ?? b.type}</span>
            <Txt s={t.join(" · ")} />
            {kids()}
            <Go from={b} />
            {badge()}
          </div>
        );
    }
  }

  function Screen(p: { s: WScreen; i: number }) {
    const s = p.s;
    const e = em.get(s.key);
    const side = s.device === "desktop" ? s.blocks.find((b) => b.type === "sidebar") : undefined;
    // A header first, before the sidebar: the app bar across the whole frame, the sidebar and the page under it.
    const top = side && s.blocks[0]?.type === "header" ? s.blocks[0] : undefined;
    const overlay = s.blocks.filter((b) => OVERLAYS.has(b.type));
    const bottom = s.blocks.filter((b) => b.type === "tabbar" || b.type === "footer");
    const flow = s.blocks.filter((b) => b !== side && b !== top && !overlay.includes(b) && !bottom.includes(b));
    const scrim = overlay.some((b) => b.type !== "toast");
    const label = `${many ? `${p.i + 1}. ` : ""}${s.name ?? (many ? `Screen ${p.i + 1}` : "Screen")}, ${s.device}`;
    return (
      <section class="vis-wf-shot" ref={(el) => (shots[p.i] = el)} tabindex="-1" aria-label={label}>
        <Show when={many || s.name}>
          <div class={`vis-wf-shot-name${e ? ` vis-wf-em-${e.tone}` : ""}`}>
            <Show when={many}>
              <span class="vis-wf-n">{p.i + 1}</span>
            </Show>
            <span>{s.name}</span>
            <Go from={s} />
            <EmBadge e={e} />
          </div>
        </Show>
        <div
          class={`vis-wf-frame vis-wf-${s.device}${e ? ` vis-wf-marked vis-wf-em-${e.tone}` : ""}`}
          style={
            fit()
              ? {
                  width: `${fit()!.widths[p.i]}px`,
                  zoom: fit()!.frames[p.i]! < 1 ? String(fit()!.frames[p.i]) : undefined,
                  // The frame's scale on screen, for the chips' touch targets (wireframe.css).
                  "--wf-k": String(fit()!.frames[p.i]! * fit()!.strip),
                }
              : undefined
          }
        >
          <div class="vis-wf-chrome" aria-hidden="true">
            <Show when={s.device === "desktop"}>
              <i />
              <i />
              <i />
            </Show>
          </div>
          <div class="vis-wf-stage">
            <div class="vis-wf-page" classList={{ "vis-wf-has-side": !!side, "vis-wf-has-top": !!top }}>
              <Show when={top}>
                <Block b={top!} />
              </Show>
              <div class="vis-wf-body">
                <Show when={side}>
                  <Block b={side!} />
                </Show>
                <div class="vis-wf-main">
                  <For each={flow}>{(b) => <Block b={b} />}</For>
                  <Show when={bottom.length}>
                    <div class="vis-wf-bottom">
                      <For each={bottom}>{(b) => <Block b={b} />}</For>
                    </div>
                  </Show>
                </div>
              </div>
            </div>
            <Show when={scrim}>
              <div class="vis-wf-scrim" aria-hidden="true" />
            </Show>
            <For each={overlay}>{(b) => <Block b={b} />}</For>
          </div>
        </div>
      </section>
    );
  }

  return (
    <div class="vis-wf" classList={{ "vis-wf-many": many }}>
      <Show when={many && overflow()}>
        <div class="vis-wf-nav">
          {/* On a phone only the current screen shows its name here, and none where it has no room; the others are their numbers. */}
          <div class="vis-wf-nav-screens" classList={{ "vis-wf-numbers": numbersOnly() }} ref={navRow} role="group" aria-label="Screens">
            <For each={spec.screens}>
              {(_, i) => (
                <button
                  type="button"
                  class="vis-wf-nav-button"
                  aria-label={`${i() + 1} ${nameOf(i())}`}
                  title={nameOf(i())}
                  aria-current={current() === i() ? "true" : undefined}
                  onClick={() => goTo(i())}
                >
                  <span class="vis-wf-n">{i() + 1}</span>
                  <span class="vis-wf-nav-name">{nameOf(i())}</span>
                </button>
              )}
            </For>
          </div>
          <span class="vis-wf-pager">
            <button type="button" class="vis-wf-nav-button vis-wf-step" disabled={current() <= 0} aria-label="Previous screen" onClick={() => goTo(Math.max(0, current() - 1))}>
              <span class="icon icon-sm" style={{ "--icon": `url("${visIcon("chevron-left")}")` }} aria-hidden="true" />
            </button>
            <button type="button" class="vis-wf-nav-button vis-wf-step" disabled={current() >= spec.screens.length - 1} aria-label="Next screen" onClick={() => goTo(Math.min(spec.screens.length - 1, current() + 1))}>
              <span class="icon icon-sm" style={{ "--icon": `url("${visIcon("chevron-right")}")` }} aria-hidden="true" />
            </button>
          </span>
        </div>
      </Show>
      <div class="vis-wf-view">
      <div class="vis-scroll vis-wf-scroll" ref={scroller} tabindex="0" role="region" aria-label={`${props.label} (scrolls sideways)`}
        onScroll={onScroll}
        onWheel={letGo}
        onTouchStart={letGo}
        onPointerDown={letGo}
        onKeyDown={letGo}
      >
        <div class="vis-wf-strip" ref={strip} style={fit() && fit()!.strip < 1 ? { zoom: String(fit()!.strip) } : undefined}>
          <For each={spec.screens}>{(s, i) => <Screen s={s} i={i()} />}</For>
          <svg class="vis-wf-arrows" aria-hidden="true">
            <For each={arrows()}>
              {(a) => (
                <>
                  <path class="vis-wf-arrow" d={a.d} />
                  <path class="vis-wf-arrow-head" d={a.head} />
                </>
              )}
            </For>
          </svg>
        </div>
      </div>
      </div>
    </div>
  );
}

/** A long word (a path, a file name) may break after / . - _ rather than at any letter. */
function Breakable(p: { s: string }) {
  return <For each={p.s.split(/(?<=[/._-])(?=[^\s/._-])/)}>{(part, i) => (i() ? [<wbr />, part] : part)}</For>;
}

const initials = (s = "") =>
  s
    .split(/\s+/)
    .map((w) => w[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();

function Chart(p: { type: "bar" | "line" | "pie" }) {
  if (p.type === "line")
    return (
      <svg class="vis-wf-chart-glyph" viewBox="0 0 200 72" preserveAspectRatio="none" aria-hidden="true">
        <path d="M0 71 H200" />
        <path class="vis-wf-chart-line" d="M0 60 L30 48 L60 52 L90 30 L120 36 L150 18 L200 10" />
      </svg>
    );
  if (p.type === "pie")
    return (
      <svg class="vis-wf-chart-glyph" viewBox="0 0 200 72" aria-hidden="true">
        <circle class="vis-wf-chart-fill" cx="100" cy="36" r="32" />
        <path d="M100 36 V4 M100 36 L128 52 M100 36 L72 55" />
      </svg>
    );
  return (
    <svg class="vis-wf-chart-glyph" viewBox="0 0 200 72" preserveAspectRatio="none" aria-hidden="true">
      <For each={[40, 58, 30, 66, 50, 22, 46]}>{(h, i) => <rect class="vis-wf-chart-fill" x={6 + i() * 28} y={72 - h} width="18" height={h} />}</For>
    </svg>
  );
}
