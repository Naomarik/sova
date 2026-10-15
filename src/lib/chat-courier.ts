// The page's courier settings (lib/chat-outbox): a chat socket like a chat view's, newest rows only,
// so its hello stays small; and the request a going page hands its frames over with
// (POST /api/chat/frames, keepalive: it outlives the page). Only for chats this server hosts: a
// peer on an older Sova lacks the route, so a peer's frames stay for the next page load.
import { wsUrl } from "./api";
import type { CourierDeps } from "./chat-outbox";
import { hostOf } from "./mesh";
import { newestOnly } from "./older-rows";

export const chatCourier: CourierDeps = {
  url: (path) => newestOnly(wsUrl("/ws/chat", path)),
  local: (path) => !hostOf(path),
  post: (path, body) => {
    if (typeof fetch !== "function") return false;
    void fetch(`/api/chat/frames?path=${encodeURIComponent(path)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
      credentials: "same-origin",
    }).catch(() => {});
    return true;
  },
};
