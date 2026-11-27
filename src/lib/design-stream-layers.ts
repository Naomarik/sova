// The live frame's documents, as layers: the one being connected or written on top, and the picture it replaces
// beneath it until the new one has painted. A page drawn again (written whole again, or the draft redrawn after an
// edit) is a new document, and the tile is never blank in between. Pure, so it can be tested without a browser.

export interface StreamLayer {
  id: number;
  url: string;
}

export interface StreamLayers {
  /** The document being written, once its link has come. */
  top: StreamLayer | null;
  /** The picture on show until `top` has painted: an earlier document of the same tile, finished. */
  under: StreamLayer | null;
  /** Whether `top` has had time to paint. */
  painted: boolean;
}

export type StreamLayerEvent =
  /** Another document is to be shown: the version or its draw changed. */
  | { t: "reconnect" }
  /** Its link came. */
  | { t: "connected"; url: string }
  /** The top document has painted: what lay beneath it goes. */
  | { t: "painted" }
  /** Its preview slot went to another tile: the open document goes; a finished one beneath holds no connection, so it stays. */
  | { t: "revoked" };

export const noStreamLayers: StreamLayers = { top: null, under: null, painted: false };

let ids = 0;

export function streamLayers(s: StreamLayers, e: StreamLayerEvent): StreamLayers {
  switch (e.t) {
    case "reconnect":
      // The picture on show stays: the top one if it had painted (the server has ended its document), else whatever it
      // was covering.
      return { top: null, under: s.painted && s.top ? s.top : s.under, painted: false };
    case "revoked":
      return { top: null, under: s.under, painted: false };
    case "connected":
      return { top: { id: ++ids, url: e.url }, under: s.under, painted: false };
    case "painted":
      return s.top ? { top: s.top, under: null, painted: true } : s;
  }
}

/** The layers to mount, bottom first. */
export const streamLayerList = (s: StreamLayers): StreamLayer[] => [s.under, s.top].filter((l): l is StreamLayer => l !== null);

/** Whether the top document is hidden: nothing painted yet, and something (an earlier picture) shows beneath it. */
export const streamTopHidden = (s: StreamLayers, over: boolean): boolean => !s.painted && (over || s.under !== null);

/** Whether the frame's own note shows: nothing painted and nothing beneath to show instead. */
export const streamNoteShown = (s: StreamLayers, over: boolean): boolean => !s.painted && !over && s.under === null;

/** Names the document a frame shows: a new version, or the same one drawn again. Undefined: nothing is being written. */
export const streamKey = (version: number | undefined, draw: number | undefined): string | undefined => (version === undefined ? undefined : `${version}:${draw ?? 0}`);
