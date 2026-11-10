// Imported right after the stall recorder by server/index.ts, and first by a chat process: a test copy of Sova
// checks that its folder is there before anything writes state, and goes on checking (server/own-folder-guard.ts).
import { startOwnFolderGuard } from "./own-folder-guard";

startOwnFolderGuard();
