# Shutter Studio Live Session SDK

TypeScript SDK for joining Shutter Studio Live Sessions, exchanging participant
events and sending or receiving audio/video. Includes a producer agent example
that transcribes the host and displays captions in the room.

The SDK is in `sdk/`; the producer agent is in `examples/producer-agent/`. Both are experimental
and not published to npm.

## Run the example

Requires Node.js 22+, npm 10+ and a Shutter Studio guest invitation URL.
Allow about 661 MB for the speech model.

```sh
git clone https://github.com/shutterapp/live-session-sdk.git
cd live-session-sdk
npm ci
npm run install:chromium
npm start -- '<guest URL>'
```

On Linux, if Chromium reports missing system libraries, run
`npx playwright install --with-deps chromium`.

`npm start` builds the project and downloads missing model files before joining.
Later runs reuse the downloaded files. Keep optional npm dependencies enabled
for the example.

The producer agent joins Setup, requests admission to Live, and transcribes the host's
English speech locally. It sends a 1280×720 Matrix-style caption video and a
silent audio track. Captions appear after speech pauses. The listening indicator
shows whether host audio is arriving.

Completed transcripts are printed to stdout alongside session events:

```json
{"event":"transcript","participantId":"host-id","text":"Hello everyone."}
```

Operational logs go to stderr. Captions are visible to room participants;
redirecting stdout also saves transcripts.

Press Ctrl+C to leave without closing the room. Treat the guest URL as a
credential, and quote it in shell commands.

### Options

| Option | Meaning |
|---|---|
| `--name NAME` | Display name, default `Producer agent` |
| `--parakeet-model DIR` | Model directory, default `models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8` |
| `--stt-threads N` | Inference threads, default `2`, range `1`–`16` |

Relative model paths resolve from the directory where you run the command.
The default model directory is inside this checkout.

The example uses [English Parakeet TDT 0.6B v2 INT8](https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8),
based on [NVIDIA Parakeet](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2),
licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

## Use the SDK

See the [examples guide](examples/README.md) to configure credentials, create a session and print its guest URL.

Build and install the SDK into another local project:

```sh
# In this checkout:
npm run build -w sdk

# In your project:
npm install /absolute/path/to/live-session-sdk/sdk
```

### Define an agent

```ts
import { defineAgent, runAgent } from "@shutter-studio/live-session-sdk";

const agent = defineAgent({
  entry: async ctx => {
    ctx.room.on("room.joined", ({ data }) => {
      console.log("Participant joined:", data.cid, data.r);
    });

    ctx.room.on("recording.started", ({ data }) => {
      console.log("Recording started:", data.id);
    });
  },
});

const shutdown = new AbortController();
await runAgent(agent, {
  guestUrl,
  connection: { name: "My agent" },
  signal: shutdown.signal,
});
```

Abort the controller to stop a run. The SDK connects, requests Live admission,
then calls `entry()` once. Returning from `entry()` finishes setup; the run stays
active until shutdown or room closure. Reconnection resumes the same run without
calling `entry()` again.

`ctx.room` provides the current snapshot, events, commands and media methods.
Use `ctx.onShutdown()` to register application cleanup, and `ctx.signal` to cancel
ongoing work. Register cleanup before starting asynchronous work. Call
`ctx.shutdown()` to request an end to the run.

`runAgent()` waits for cleanup, event handlers and media shutdown before returning.
Entry or event-handler failures end the run and reject its promise. Application
work must honor cancellation; the SDK does not forcibly terminate your code.

See [`examples/producer-agent/src/producer-agent.ts`](examples/producer-agent/src/producer-agent.ts) for
the producer agent definition.

### Connect directly

To create a photo session and share the guest invite before entering the room:

```ts
import { createSession, getGuestInviteUrl, LiveSessionClient } from "@shutter-studio/live-session-sdk";

const access = { baseUrl, apiToken };
const session = await createSession(access, "Portrait");
const invite = await getGuestInviteUrl(access, session.shootId);
if (invite) await sendInvite(invite); // Your delivery method.
```

For photo shoots, the link opens the latest session. You can create and share
an invite with an API key. Joining as Host with that key isn't supported yet.

Use `LiveSessionClient` when you want to manage the connection and lifecycle yourself:

```ts
import { LiveSessionClient } from "@shutter-studio/live-session-sdk";

const client = new LiveSessionClient(guestUrl, { name: "My participant" });
const unsubscribe = client.onEvent(({ type, participantId }) => {
  console.log(type, participantId);
});

await client.connect(); // Join Setup.
const room = await client.knock(); // Request admission to Live.
console.log(room.area);

if (room.area === "Live") {
  client.publish("agent.status", { state: "ready" });
}

// When finished:
unsubscribe();
client.disconnect();
```

`snapshot` contains the current room state. `publish(type, data, recipientId?)`
sends a participant event in Live, optionally addressed to one participant.
Publishing has no acknowledgement.

The client reconnects after transport loss and resumes the existing session.
It emits `reconnecting` during recovery and `joined` with the refreshed snapshot
after resuming. Pending commands fail and are not replayed; publishing during
recovery throws.

Disconnect, room closure, duplicate-session and protocol rejection stop the
client. Create a new client for a new connection.
Use `await client.close()` to also wait for media shutdown.

### Commands and events

Both APIs support:

```ts
room.on("room.left", ({ data }) => console.log("Participant left:", data.cid));
room.on("layout.changed", event => handleLayout(event.data));
room.onEvent(event => handleAnyEvent(event));

const response = await room.command("custom-command", { setting: "value" });
room.sendCommand("custom-notification", { setting: "value" });

room.startRecording();
room.stopRecording();
```

Here `room` is `ctx.room` or a `LiveSessionClient`.
`on()` filters events by name and types established protocol payloads.
`onEvent()` receives all events. Custom event names and payloads pass through;
`snapshot` supplies the state of participants already in the room.

Use `command()` only for commands with server replies. `sendCommand()` sends
without awaiting a reply. Recording commands are send-only: listen for
`recording.started` and `recording.stopped` to observe state changes.
The server controls authorization.

### Send and receive media

Install Chromium with `npm run install:chromium`. Supply a trusted browser script
that defines `window.studioMediaSource`, either directly or as a promise:

```ts
interface BrowserMediaSource {
  stream: MediaStream; // One audio track, one video track, or both.
  update?(state: Record<string, unknown>): void | Promise<void>;
  onRemoteTrack?(participantId: string, track: MediaStreamTrack): void;
  onPeerState?(participantId: string, state: RTCPeerConnectionState): void;
  stop(): void | Promise<void>;
}
```

Load that script when starting media:

```ts
import { readFile } from "node:fs/promises";

await client.startMedia({
  sourceScript: await readFile("./my-browser-source.js", "utf8"),
  initialState: { message: "Ready" },
  onEvent: event => console.log(event),
});

await client.updateMedia({ message: "Updated" });
await client.stopMedia(); // Leave signaling connected.
```

`updateMedia()` calls the source's `update()` method. The browser source can
send events back through `window.studioMediaEmit(event)`.

Use `videoEncoding` to set `maxBitrate`, `maxFramerate`, `scaleResolutionDownBy`
or `degradationPreference`. Use `iceUrl` to override ICE discovery, or supply
`iceServers` directly. Disconnecting stops media and calls the source's `stop()`.
`browserPermissions` grants requested permissions to the media page automatically;
for example, `["local-network-access"]` allows a source to connect to local services.

See [`examples/producer-agent/src/browser-entry.ts`](examples/producer-agent/src/browser-entry.ts) for
a complete media source.

## Recording

The example participates in the room but does not upload recordings. Remove it
before starting a production recording, or an assigned recording track may
remain incomplete.

## Development

Run from the repository root:

```sh
npm run build
npm test
```

To enable local secret scanning:

```sh
mise trust
mise install
mise exec -- npm run secrets:scan
npm run hooks:install
```
