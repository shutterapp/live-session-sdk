# Shutter Studio Live Session SDK

TypeScript SDK for joining Shutter Studio Live Sessions, exchanging participant
events and sending or receiving audio/video. Includes a caption-agent example
that transcribes the host and displays captions in the room.

The SDK is in `sdk/`; the example is in `example-app/`. Both are experimental
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

The agent joins Setup, requests admission to Live, and transcribes the host's
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
| `--name NAME` | Display name, default `AI agent` |
| `--device-id UUID` | Reuse a previously returned device ID |
| `--parakeet-model DIR` | Model directory, default `models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8` |
| `--stt-threads N` | Inference threads, default `2`, range `1`–`16` |
| `--rooms-url URL` | Invitation endpoint override |
| `--ws-url URL` | Live WebSocket endpoint override |
| `--ice-url URL` | ICE configuration endpoint override |

Relative model paths resolve from the directory where you run the command.
The default model directory is inside this checkout.

The example uses [English Parakeet TDT 0.6B v2 INT8](https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8),
based on [NVIDIA Parakeet](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2),
licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

## Use the SDK

Build and install the SDK into another local project:

```sh
# In this checkout:
npm run build -w sdk

# In your project:
npm install /absolute/path/to/live-session-sdk/sdk
```

### Join a session

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

See [`example-app/src/browser-entry.ts`](example-app/src/browser-entry.ts) for
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
