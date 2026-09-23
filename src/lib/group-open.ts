// Open/closed state for the sidebar's GROUPS region and the group sections inside it
// (spec/02-session-list.md §2 "Groups").
//
// Both are COLLAPSED on every page load, and neither is persisted: the choice lives only in the
// tab's memory for as long as the page does, so a reload always shows the region closed, whatever
// the user opened last time. There is deliberately no storage key here — `folder-open` and the
// Archive have one, this doesn't, and that difference is the whole feature.
//
// Pure on purpose, like `folder-open`: the rules are what a unit test can hold, and the component
// keeps the (memory-only) state.

/**
 * Whether a group section is open right now. `chosen` is what the user did to THIS group since the
 * page loaded; nothing chosen means collapsed — there is no stored choice to fall back to.
 */
export const groupOpen = (chosen: boolean | undefined): boolean => chosen ?? false;

/**
 * Whether the Groups region itself is open right now. It is forced open, WITHOUT changing the
 * user's choice, while a search is on (a matching group must not hide its hits), while a
 * grouped row is being dragged (the group sections and the "Remove from …" target it needs are
 * inside the region), and while the new-group name field is showing (`composing`: the head's `+`
 * opens that field in the region's body, and a collapsed region would hide the field the user
 * just asked for). Otherwise it is the user's choice, and collapsed until they make one — so when
 * the field closes, a region the user never opened is closed again.
 */
export function groupsRegionOpen(input: {
  chosen?: boolean | undefined;
  searching: boolean;
  draggingGrouped: boolean;
  composing: boolean;
}): boolean {
  return input.searching || input.draggingGrouped || input.composing || groupOpen(input.chosen);
}
