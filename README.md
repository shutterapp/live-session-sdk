# Live Session SDK and caption-agent example

Two separate npm workspaces:

```text
sdk/
  src/                 Guest authentication, Live signaling and WebRTC transport
  test/                SDK protocol and transport tests
example-app/
  src/cli.ts           Caption-agent CLI
  src/browser-entry.ts Browser media source: silent microphone and host PCM capture
  src/matrix-video.ts  Matrix video presentation and live indicator
  src/parakeet*.ts     Local STT worker and model provisioning
  src/host-captions.ts Host selection and caption behavior
```

The SDK has no renderer, model downloader, STT runtime, speech segmentation,
host-caption policy or generated microphone. Those belong to the example.
The example consumes the SDK; the SDK never imports the example. No other
Shutter Studio checkout or build output is needed. Both packages are experimental
and private, not published to npm.

## Prerequisites

- Node.js 22+ and npm 10+.
- Git for cloning.
- Playwright Chromium and its system libraries for media.
  See [supported operating systems](https://playwright.dev/docs/intro#system-requirements).
- For the example: macOS Intel/Apple Silicon, Linux or Windows supported by
  `sherpa-onnx-node`, and about 661 MB free disk space for model files.
- Internet access for initial dependency, browser and model downloads.
- A valid guest invitation and reachable Rooms HTTP, Live WebSocket and ICE/TURN
  endpoints for real sessions. Tests use loopback peers, not a live account.

The example runs on CPU. No Python, CUDA, cloud STT account, physical microphone,
camera or display is needed. npm selects native STT and build-tool binaries for
your architecture. Use a native Node installation matching your Mac's architecture.
Linux verification does not certify native macOS execution.

## Install and run

```sh
git clone https://github.com/shutterapp/live-session-sdk.git
cd live-session-sdk
npm ci
npm run install:chromium
npm start -- '<guest URL>'
```

`npm start` builds SDK first, then the example, before launching. TypeScript's
incremental metadata skips unchanged code; esbuild bundles the example's browser
source. Workspace starts work too: `npm start -w example-app -- '<guest URL>'`.

On supported Linux distributions, install missing browser libraries with
`npx playwright install --with-deps chromium` (administrator access required).
SDK consumers using only signaling do not need Chromium or the example's model.

All following commands run from the repository root:

| Command | Purpose |
|---|---|
| `npm ci` | Install locked workspace dependencies |
| `npm run install:chromium` | Install matching Chromium |
| `npm run build` | Build SDK and example |
| `npm run build -w sdk` | Build SDK only |
| `npm run build -w example-app` | Build example after SDK |
| `npm start -- --help` | Build if needed and show CLI usage |
| `npm start -- '<guest URL>'` | Run the local caption agent |
| `npm test` | Run SDK tests |
| `npm test -w sdk` | Run SDK tests only |

Build outputs, local models and incremental metadata are ignored by Git.

## Example behavior

The CLI always transcribes host audio locally and displays captions on generated
video. There is no signaling-only or uncaptioned mode.

Before joining, it automatically downloads any missing English Parakeet TDT
0.6B v2 INT8 files. Downloads stream to temporary files, are checked against pinned
SHA-256 digests and byte sizes, then published atomically. Progress goes to stderr.
Ctrl+C aborts downloads and removes temporary files. Failures prevent room entry.
Existing nonempty files are reused offline without replacement or rehashing.

The default directory is
`models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8` inside this checkout.
Downloads use the pinned
[sherpa-onnx conversion](https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8/tree/84b478d541cdbf0c296a7ab5f1e20a6f8f998114)
of [NVIDIA Parakeet](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2),
licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
No archive utility is needed.

Normal `npm ci` installs the example's optional `sherpa-onnx-node` package.
Do not omit optional dependencies when running the example. The SDK has no
dependency on that runtime.

### Video and audio

- Matrix-style black/green 1280×720 canvas video at 15 fps, with falling code and
  readable monospace captions.
- A live outgoing microphone track containing digital silence. No physical
  microphone capture or white-noise generator.
- A persistent `LIVE / LISTENING` badge while selected host PCM arrives, including
  silence and after caption updates. Its solid dot never blinks off.
- Separate `WAITING FOR HOST`, `AUDIO WAIT` and `STT OFFLINE` states. No fresh PCM
  for 1.5 seconds removes the listening claim.
- Audio-level history uses actual host PCM. Reduced motion disables decorative
  animation, not the live indicator.
- The example requests resolution-priority encoding with a 3 Mbps ceiling;
  congestion can reduce frame rate.

Only the non-legacy remote participant with server role `Host` is transcribed.
Guest tracks and the outgoing silent microphone are excluded. Host departure
clears captions and unfinished audio. The example's browser source extracts mono
16 kHz PCM in 100 ms frames. Its energy gate uses 600 ms silence endpoints and an
eight-second utterance cap. Parakeet inference runs in a worker thread.

Captions appear after speech pauses or a chunk fills, not word-by-word.
Noise can trigger the gate and quiet speech can be missed. One decoding utterance
and one waiting utterance bound memory; overflow logs `stt.audio.dropped`.

Completed host utterances are also printed to stdout:

```json
{"event":"transcript","participantId":"host-id","text":"Hello everyone."}
```

Operational logs go to stderr. The app writes no audio or transcript files, but
terminal capture and redirected stdout can retain speech. Captions are visible
to all media peers. No audio is sent to a cloud STT provider.

### CLI options

| Option | Meaning |
|---|---|
| `--name NAME` | Display name, default `AI agent` |
| `--device-id UUID` | Reuse a previously returned device ID |
| `--parakeet-model DIR` | Override the local model directory |
| `--stt-threads N` | CPU inference threads, default `2`, range `1`–`16` |
| `--rooms-url URL` | Override complete invitation endpoint |
| `--ws-url URL` | Override complete Live WebSocket endpoint |
| `--ice-url URL` | Override complete ICE configuration endpoint |

Relative model paths resolve from the invocation directory, including npm
workspace launches. Quote guest URLs: they contain credentials, can appear in
shell history/process listings, and contain shell-sensitive `&` characters.

## SDK: signaling

```ts
import { LiveSessionClient } from "@shutter-studio/live-session-sdk";

const client = new LiveSessionClient(guestUrl, { name: "My participant" });
client.onEvent(({ type, participantId }) => console.log(type, participantId));
await client.connect(); // Invitation exchange and Setup join.
await client.knock();   // Returns the server's actual admission area.
// Later:
client.disconnect();    // leave {close:false}; never closes the host's room.
```

`parseGuestUrl()` extracts the base before `/sessions`, numeric session ID,
`roomId` and credential `g`. Default endpoints are
`<base>/api/rooms/v2/join-room` and WS(S) `<base>/api/live/ws`.
The returned `ws.token` is used unchanged. No fabricated identity, Dashboard
login or Collider registration is required. HTTP redirects are refused.

`snapshot` tracks room state. `onEvent` returns an unsubscribe function.
`publish(type,data,recipientId?)` sends an unacknowledged participant event only
in Live. Heartbeats, pending request timeouts and terminal errors are handled.

Transport loss or a heartbeat timeout emits `reconnecting` and retries after two
seconds. The next connection sends `resume` with the existing session ID, without
another invitation exchange or knock. Successful admission or resumption emits
`joined` with the current snapshot. Pending commands fail on transport loss and
are not replayed; publishing while reconnecting fails rather than queueing.
Media stays alive during transport recovery. Explicit disconnect, room closure,
duplicate-session, invalid protocol messages and rejected handshakes are terminal.
A disconnected client instance cannot be restarted.

For another local project, build the SDK and install its directory with
`npm install /absolute/path/to/live-session-sdk/sdk`.

## SDK: caller-owned media

The SDK launches Chromium and handles peer negotiation, SDP and ICE. The caller
supplies a trusted browser script defining `window.shutterMediaSource`, either
directly or as a promise resolving to:

```ts
interface BrowserMediaSource {
  stream: MediaStream; // At most one audio and one video track; at least one track.
  update?(state: Record<string, unknown>): void | Promise<void>;
  onRemoteTrack?(participantId: string, track: MediaStreamTrack): void;
  onPeerState?(participantId: string, state: RTCPeerConnectionState): void;
  stop(): void | Promise<void>;
}
```

```ts
await client.startMedia({
  sourceScript: await readFile("./my-browser-source.js", "utf8"),
  initialState: { message: "Ready" },
  onEvent: event => handleMySourceEvent(event),
});
await client.updateMedia({ message: "Updated by my application" });
await client.stopMedia(); // Keeps Live signaling connected.
```

The browser source can send opaque events to its caller with
`window.shutterMediaEmit(event)`. The SDK does not interpret their contents or
source updates. Track generation, capture, UI, audio processing and application
policy are the caller's responsibility. Only run trusted source scripts.

`videoEncoding` optionally sets `maxBitrate`, `maxFramerate`, `scaleResolutionDownBy` and
`degradationPreference`; the SDK imposes no presentation resolution or frame rate.
ICE defaults to `POST <base>/api/legacy-rooms/ice` using the session access token,
or use `iceUrl` / explicit `iceServers`.

Transport supports modern `webrtc.p2p.*`, not Collider or LiveKit.
Audio/video goes directly through WebRTC, not Node. The example separately sends
selected host PCM through its source-event bridge for local recognition.
Disconnect and terminal room events close the media worker; the caller stops
its own application workers. Chromium is muted to prevent local speaker output.

## Tests

SDK tests exercise real loopback HTTP/WebSocket and Chromium peers using neutral
test sources under `sdk/test/`. They do not import example code or need STT model
downloads. The example app has no test suite or test runner.

## Session impact

Joining changes membership, can upgrade a room and can count toward session start.
Roles remain server-owned; there is no secondary Producer capability.
No recording upload is implemented. Do not leave this agent in a production room
when starting a recording: an assigned Track can remain unfulfilled.

## Local secret scanning

Betterleaks 1.10.1 is pinned in `mise.toml`:

```sh
mise trust
mise install
mise exec -- npm run secrets:scan
mise exec -- npm run secrets:history
mise exec -- npm run secrets:staged
npm run hooks:install
```

Without mise, put that Betterleaks version and Node on `PATH`. The optional
pre-commit hook uses `.githooks`; `npm ci` does not install it automatically.
The scanner redacts findings, disables live validation, extends built-in rules
and detects guest invitation UUIDs. Dependencies, generated output, `models/`
and Git internals are excluded; source, tests and docs remain scanned.
There are no GitHub Actions workflows.
