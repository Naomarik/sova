// Ask the app to read the session list now, instead of at its next poll: for a view whose action
// changed a row's fields (a baton hand-off moves the sidebar's " · <holder>"). App listens.

export const LIST_REFRESH_EVENT = "sova:list-refresh";

export const requestListRefresh = (): void => void window.dispatchEvent(new Event(LIST_REFRESH_EVENT));
