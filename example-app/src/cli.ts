#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { LiveSessionClient } from "@shutter-studio/live-session-sdk";
import { ensureParakeetModel } from "./parakeet-model.js";
import { HostCaptions } from "./host-captions.js";

const defaultModelDirectory = fileURLToPath(new URL(
  "../../models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8", import.meta.url,
));

const usage = `Usage: live-session '<guest URL>' [--name 'AI agent'] [--device-id UUID]

Transcribes host audio locally with English Parakeet and displays captions on generated video.
Completed host transcripts are printed to stdout as JSON.
Requires Chromium. Missing model files are downloaded automatically before joining.
--parakeet-model DIR overrides the local model directory.
--stt-threads N sets CPU inference threads (default 2, range 1-16).
No producer privileges or recording uploads.
Joins Setup, then knocks to enter Live. Ctrl+C leaves without closing the room.
Use --rooms-url and --ws-url for deployments with different API routes.
URLs contain a guest credential. Quote them and keep shell history private.`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" }, name: { type: "string" },
      "device-id": { type: "string" },
      "rooms-url": { type: "string" }, "ws-url": { type: "string" },
      "ice-url": { type: "string" },
      "parakeet-model": { type: "string" }, "stt-threads": { type: "string" },
    },
  });
  if (values.help) { console.log(usage); return; }
  if (positionals.length !== 1) throw new Error(usage);
  const modelDirectory = values["parakeet-model"]
    ? resolve(process.env.INIT_CWD ?? process.cwd(), values["parakeet-model"])
    : defaultModelDirectory;
  const client = new LiveSessionClient(positionals[0]!, {
    name: values.name, deviceId: values["device-id"],
    roomsUrl: values["rooms-url"], webSocketUrl: values["ws-url"],
    logger: entry => {
      console.error(`${entry.level.toUpperCase()} ${entry.operation}`);
      if (entry.level === "error") process.exitCode = 1;
    },
  });
  const captions = new HostCaptions(client, {
    modelDirectory, numThreads: values["stt-threads"] ? Number(values["stt-threads"]) : undefined,
  }, ({ participantId, text }) => console.log(JSON.stringify({ event: "transcript", participantId, text })),
  (operation, error) => {
    console.error(`${error ? "ERROR" : "INFO"} ${operation}`);
    if (error) process.exitCode = 1;
  });
  let mediaReady = false;
  let stopping = false;
  const downloadAbort = new AbortController();
  const stop = () => {
    stopping = true;
    downloadAbort.abort();
    client.disconnect();
    void captions.stop();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  client.onEvent(event => {
    // Session snapshots can contain credentials; print event names, never raw payloads.
    console.log(JSON.stringify({ event: event.type, participantId: event.participantId }));
    if (mediaReady && ["joined", "room.joined", "room.left"].includes(event.type)) captions.syncParticipants();
    if (event.type === "room.closed") stopping = true;
    if (event.type === "duplicate-session") process.exitCode = 1;
    if (event.type === "disconnected") {
      void captions.stop();
      if (!stopping) process.exitCode = 1;
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  });
  try {
    const sourceScript = await readFile(new URL("./browser.js", import.meta.url), "utf8");
    await ensureParakeetModel(modelDirectory, {
      signal: downloadAbort.signal,
      onProgress: ({ file, received, total }) => {
        console.error(`INFO stt.model.download ${file} ${Math.floor(received / total * 100)}%`);
      },
    });
    if (stopping) return;
    const captionChannel = await captions.start();
    if (stopping) return;
    let room = await client.connect();
    await client.startMedia({
      iceUrl: values["ice-url"],
      sourceScript: `window.studioCaptionChannel = ${JSON.stringify(captionChannel)};\n${sourceScript}`,
      browserPermissions: ["local-network-access"],
      videoEncoding: {
        maxBitrate: 3_000_000, maxFramerate: 15, scaleResolutionDownBy: 1, degradationPreference: "maintain-resolution",
      },
    });
    mediaReady = true;
    captions.syncParticipants();
    if (room.area !== "Live") room = await client.knock();
    if (room.area === "Live") {
      client.publish("device.devices.list", [
        { id: "silent-mic", kind: "audioinput", label: "Silent microphone" },
        { id: "matrix-camera", kind: "videoinput", label: "Matrix captions" },
      ]);
      client.publish("device.devices.state", {
        audioinput: { current: "silent-mic", pending: null, paused: false, echoCancellation: false, noiseSuppression: false },
        videoinput: { current: "matrix-camera", pending: null, paused: false },
        audiooutput: { current: null, pending: null, paused: true },
      });
    }
    console.log(JSON.stringify({
      status: "connected", baseUrl: client.address.baseUrl, sessionId: client.address.sessionId,
      roomId: client.address.roomId, deviceId: client.deviceId,
      participantId: room.self.cid, role: room.self.r, area: room.area,
    }));
  } catch (error) {
    client.disconnect();
    await captions.stop();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    if (stopping) return;
    throw error;
  }
}

void main().catch(error => {
  // parseArgs errors may echo arguments; never print the raw exception.
  console.error(error instanceof Error && !("code" in error) ? error.message : "Invalid CLI arguments; use --help");
  process.exitCode = 1;
});
