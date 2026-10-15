// The page's courier settings (lib/chat-outbox): a chat socket like a chat view's, newest rows only,
// so its hello stays small.
import { wsUrl } from "./api";
import type { CourierDeps } from "./chat-outbox";
import { newestOnly } from "./older-rows";

export const chatCourier: CourierDeps = { url: (path) => newestOnly(wsUrl("/ws/chat", path)) };
