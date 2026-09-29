#!/usr/bin/env node
// A stand-in for whisper.cpp's whisper-server, like scripts/fake-claude.mjs is for `claude`: the
// argv voice passes, /health, and a POST /inference that answers canned text. Never loads a model.
// With FAKE_WHISPER_ENGINE=transcribe it stands in for sova-transcribe-host (Parakeet) instead:
// /inference takes the raw WAV body and no fields (SOVA_VOICE_TRANSCRIBE_BIN points here).
//
//   --host H --port P -m MODEL -t N --inference-path /inference [-vm VAD] [--no-gpu]   (as whisper-server)
//   --help                                                                              (exits 0)
//
// Knobs (environment):
//   FAKE_WHISPER_TEXT        the transcript (default: "Open Sova, and run the type check in the worktree.")
//   FAKE_WHISPER_LOAD_MS     how long /health answers 503 "loading" first (default 0)
//   FAKE_WHISPER_DELAY_MS    how long each /inference takes (default 0)
//   FAKE_WHISPER_CRASH       "start": exit 1 at once · "inference": exit 1 on the first /inference
//   FAKE_WHISPER_HANG        "health": never answer /health · "inference": never answer /inference
//   FAKE_WHISPER_TEXT_BY     JSON {"<field>=<value>": text, …}: the first entry a request's fields
//                            match answers instead (e.g. {"beam_size=5": "…"}), so settings score apart
//   FAKE_WHISPER_ENGINE      "transcribe": the Parakeet host's surface (raw WAV body, no fields); a
//                            `-m` ending in .gguf picks it too
//   FAKE_TRANSCRIBE_TEXT     the transcript in that mode (default: "Open sofa and run the type check in the work tree.")
//   FAKE_WHISPER_LOG         a file to append each request to (JSON lines: {path, argv, fields, bytes, contentType})
//   FAKE_WHISPER_DEVICE      print a Vulkan device line like the real server ("ggml_vulkan: 0 = …")

import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log("usage: whisper-server [options]  (fake)");
  process.exit(0);
}
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};
const host = arg("--host", "127.0.0.1");
const port = Number(arg("--port", "8080"));
const inferencePath = arg("--inference-path", "/inference");
const env = process.env;
// A .gguf model is transcribe.cpp's (Parakeet), so one stand-in serves both engines across a switch.
const engine = env.FAKE_WHISPER_ENGINE === "transcribe" || /\.gguf$/i.test(arg("-m", "")) ? "transcribe" : "whisper";
const text =
  engine === "transcribe"
    ? (env.FAKE_TRANSCRIBE_TEXT ?? "Open sofa and run the type check in the work tree.")
    : (env.FAKE_WHISPER_TEXT ?? "Open Sova, and run the type check in the worktree.");
const textBy = env.FAKE_WHISPER_TEXT_BY ? Object.entries(JSON.parse(env.FAKE_WHISPER_TEXT_BY)) : [];
/** whisper-server answers a `vad` request with 500 when it was started without -vm. */
const vadModel = arg("-vm", arg("--vad-model", null));
const loadMs = Number(env.FAKE_WHISPER_LOAD_MS ?? 0);
const delayMs = Number(env.FAKE_WHISPER_DELAY_MS ?? 0);

if (env.FAKE_WHISPER_CRASH === "start") {
  console.error("fake whisper-server: crashing at start");
  process.exit(1);
}
if (env.FAKE_WHISPER_DEVICE) console.error(`ggml_vulkan: 0 = ${env.FAKE_WHISPER_DEVICE} (fake) | uma: 1`);
console.error(`whisper_init_with_params_no_state: use gpu    = ${argv.includes("--no-gpu") ? 0 : 1}`);
const started = Date.now();

/** multipart/form-data text fields (enough for the fields voice sends) and the file's size. */
function parseMultipart(body, type) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(type ?? "");
  const out = { fields: {}, fileBytes: 0 };
  if (!m) return out;
  const boundary = `--${m[1] ?? m[2]}`;
  const raw = body.toString("latin1");
  for (const part of raw.split(boundary)) {
    const head = part.indexOf("\r\n\r\n");
    if (head < 0) continue;
    const headers = part.slice(0, head);
    const value = part.slice(head + 4).replace(/\r\n$/, "");
    const name = /name="([^"]+)"/.exec(headers)?.[1];
    if (!name) continue;
    if (/filename=/.test(headers)) out.fileBytes = Buffer.byteLength(value, "latin1");
    else out.fields[name] = Buffer.from(value, "latin1").toString("utf8");
  }
  return out;
}

let inferences = 0;
const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    if (req.url === "/health") {
      if (env.FAKE_WHISPER_HANG === "health") return;
      if (Date.now() - started < loadMs) {
        res.writeHead(503, { "Content-Type": "application/json" }).end(JSON.stringify({ status: "loading model" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (req.method === "POST" && req.url === inferencePath) {
      inferences++;
      const body = Buffer.concat(chunks);
      const contentType = req.headers["content-type"] ?? "";
      const parsed = engine === "transcribe" ? { fields: {}, fileBytes: body.length } : parseMultipart(body, contentType);
      if (env.FAKE_WHISPER_LOG) appendFileSync(env.FAKE_WHISPER_LOG, `${JSON.stringify({ path: req.url, argv, fields: parsed.fields, bytes: parsed.fileBytes, contentType })}\n`);
      if (env.FAKE_WHISPER_CRASH === "inference" && inferences === 1) {
        console.error("fake whisper-server: crashing on inference");
        process.exit(1);
      }
      if (env.FAKE_WHISPER_HANG === "inference") return;
      if (engine === "transcribe" && !contentType.startsWith("audio/wav")) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "a WAV body with a Content-Length is required" }));
        return;
      }
      if (engine === "whisper" && parsed.fields.vad === "true" && !vadModel) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "failed to process audio" }));
        return;
      }
      const hit = textBy.find(([k]) => {
        const [f, v] = k.split("=");
        return parsed.fields[f] === v;
      });
      const answer = hit ? String(hit[1]) : text;
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ text: ` ${answer}\n` }));
      }, delayMs);
      return;
    }
    res.writeHead(404).end("not found");
  });
});
server.listen(port, host, () => console.error(`whisper server listening at http://${host}:${port}`));
process.on("SIGTERM", () => process.exit(0));
