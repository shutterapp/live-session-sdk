#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "@shutter-studio/live-session-sdk";
import { ensureParakeetModel } from "./parakeet-model.js";
import { createProducerAgent } from "./producer-agent.js";

const defaultModelDirectory = fileURLToPath(new URL(
  "../../models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8", import.meta.url,
));

const usage = `Usage: live-session '<guest URL>' [--name 'Producer agent']

Runs the producer agent in a Shutter Studio Live Session.
Host speech is transcribed locally and displayed as video captions.
Completed transcripts are printed to stdout as JSON.
Requires Chromium. Missing model files are downloaded before joining.
--parakeet-model DIR overrides the model directory.
--stt-threads N sets inference threads (default 2, range 1-16).
Ctrl+C leaves without closing the room.
Guest URLs contain credentials. Quote them and keep shell history private.`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" }, name: { type: "string" },
      "parakeet-model": { type: "string" }, "stt-threads": { type: "string" },
    },
  });
  if (values.help) { console.log(usage); return; }
  if (positionals.length !== 1) throw new Error(usage);
  const modelDirectory = values["parakeet-model"]
    ? resolve(process.env.INIT_CWD ?? process.cwd(), values["parakeet-model"])
    : defaultModelDirectory;
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  const log = (operation: string, error = false) => {
    console.error(`${error ? "ERROR" : "INFO"} ${operation}`);
    if (error && !shutdown.signal.aborted) process.exitCode = 1;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    try {
      await ensureParakeetModel(modelDirectory, {
        signal: shutdown.signal,
        onProgress: ({ file, received, total }) => {
          console.error(`INFO stt.model.download ${file} ${Math.floor(received / total * 100)}%`);
        },
      });
    } catch (error) {
      if (shutdown.signal.aborted) return;
      throw error;
    }
    const agent = createProducerAgent({
      modelDirectory, numThreads: values["stt-threads"] ? Number(values["stt-threads"]) : undefined,
    }, log);
    await runAgent(agent, {
      guestUrl: positionals[0]!,
      signal: shutdown.signal,
      connection: {
        name: values.name ?? "Producer agent",
        logger: entry => log(entry.operation, entry.level === "error"),
      },
    });
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

void main().catch(error => {
  // parseArgs errors may echo arguments; never print the raw exception.
  console.error(error instanceof Error && !("code" in error) ? error.message : "Invalid CLI arguments; use --help");
  process.exitCode = 1;
});
