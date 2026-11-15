#!/usr/bin/env node
import { parseArgs } from "node:util";
import { LiveSessionClient } from "@shutter-studio/live-session-sdk";

const usage = `Usage: live-session '<guest URL>' [--name 'AI agent'] [--device-id UUID] [--setup-only]

Connects a headless guest. --synthetic-media publishes quiet white noise and 640x360 test video.
No producer privileges or recording uploads.
Default: join Setup, then knock to enter Live. Ctrl+C leaves without closing the room.
Use --rooms-url and --ws-url for deployments with different API routes.
URLs contain a guest credential. Quote them and keep shell history private.`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" }, name: { type: "string" },
      "device-id": { type: "string" }, "setup-only": { type: "boolean" },
      "rooms-url": { type: "string" }, "ws-url": { type: "string" },
      "synthetic-media": { type: "boolean" }, "ice-url": { type: "string" },
    },
  });
  if (values.help) { console.log(usage); return; }
  if (positionals.length !== 1) throw new Error(usage);
  if (values["setup-only"] && values["synthetic-media"]) throw new Error("--synthetic-media cannot be combined with --setup-only");
  const client = new LiveSessionClient(positionals[0]!, {
    name: values.name, deviceId: values["device-id"],
    roomsUrl: values["rooms-url"], webSocketUrl: values["ws-url"],
    logger: entry => {
      console.error(`${entry.level.toUpperCase()} ${entry.operation}`);
      if (entry.level === "error") process.exitCode = 1;
    },
  });
  let stopping = false;
  const stop = () => { stopping = true; client.disconnect(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  client.onEvent(event => {
    // Session snapshots can contain credentials; print event names, never raw payloads.
    console.log(JSON.stringify({ event: event.type, participantId: event.participantId }));
    if (event.type === "room.closed") stopping = true;
    if (event.type === "duplicate-session") process.exitCode = 1;
    if (event.type === "disconnected") {
      if (!stopping) process.exitCode = 1;
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  });
  try {
    let room = await client.connect();
    if (values["synthetic-media"]) await client.startSyntheticMedia({ iceUrl: values["ice-url"] });
    if (!values["setup-only"] && room.area !== "Live") room = await client.knock();
    console.log(JSON.stringify({
      status: "connected", baseUrl: client.address.baseUrl, sessionId: client.address.sessionId,
      roomId: client.address.roomId, deviceId: client.deviceId,
      participantId: room.self.cid, role: room.self.r, area: room.area,
      syntheticMedia: values["synthetic-media"] ?? false,
    }));
  } catch (error) {
    client.disconnect();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    throw error;
  }
}

void main().catch(error => {
  // parseArgs errors may echo arguments; never print the raw exception.
  console.error(error instanceof Error && !("code" in error) ? error.message : "Invalid CLI arguments; use --help");
  process.exitCode = 1;
});
