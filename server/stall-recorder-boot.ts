// Imported first by server/index.ts, so the recorder runs before any other module of the server
// loads: a stall in the load itself is a stall like any other. Nothing heavy may be imported here.

import { startStallRecorder } from "./stall-recorder";
import { stallLogDir } from "./stall-recorder-core";

startStallRecorder({ dir: stallLogDir() });
