# Experimental Live Session SDK

Standalone TypeScript package for headless Node.js participants. No Angular
dependencies. Node 22+ supplies HTTP fetch and WebSocket. Playwright controls an
optional headless Chromium media worker; no native Node WebRTC addon is used.
The example app always transcribes host audio locally with English Parakeet and
displays captions on generated video. It has no signaling-only or test-pattern-only mode.

## Repository layout

```text
sdk/
  src/                 Reusable SDK, signaling and Chromium media worker
  test/                SDK tests and local peer fixtures
  dist/                Generated SDK JavaScript and declarations
example-app/
  src/cli.ts           Example Node.js CLI using the SDK's public package export
  dist/                Generated example CLI
package.json           npm workspace commands
```

The SDK does not import the example app. Each workspace has its own package and
TypeScript build; the example depends on `@shutter-studio/live-session-sdk`.
Both packages are private and experimental, not published to npm.
This repository is self-contained. No checkout, build output or dependency from
Photo Session App or any other Shutter Studio repository is required.

## Prerequisites

- Git to clone the repository.
- Node.js 22 or newer and npm 10 or newer, with npm workspace support.
- For the example app and media tests: Playwright's Chromium browser and
  its OS libraries. Supported Windows, macOS and Linux hosts are listed in
  [Playwright's system requirements](https://playwright.dev/docs/intro#system-requirements).
  Headless operation needs no display, physical camera or microphone.
- For the example app's local captions: a supported macOS (Apple Silicon or Intel), Linux or Windows
  host with the optional `sherpa-onnx-node` package installed by normal `npm ci`,
  plus enough disk space for about 661 MB of model files. The CLI downloads
  missing files automatically on first run. Inference runs on CPU;
  no Python, CUDA, API key or cloud STT service is needed.
- Internet access for npm/browser downloads and the first model download. Live runs also need a valid guest
  invitation, reachable Rooms HTTP and Live WebSocket endpoints, and ICE/TURN
  connectivity for media. Local tests need loopback networking, not a live account.

## Install and build

```sh
git clone https://github.com/shutterapp/live-session-sdk.git
cd live-session-sdk
npm ci
npm run install:chromium
npm run build
```

On supported Linux distributions, install missing browser system libraries with
`npx playwright install --with-deps chromium` (requires administrator access).
The example downloads missing Parakeet files automatically before joining a room.
Only SDK consumers using signaling without media can skip Chromium and the model.
Run all commands below from the repository root.

| Command | Purpose |
|---|---|
| `npm ci` | Install locked dependencies and link the local workspaces |
| `npm run install:chromium` | Download the Chromium version matching Playwright |
| `npm run build` | Build SDK first, then the example app |
| `npm run build -w sdk` | Build only the SDK |
| `npm run build -w example-app` | Build only the example; SDK must already be built |
| `npm test` | Build the SDK and run its full test suite, including Chromium media |
| `npm start -- --help` | Build if needed, then show example CLI usage |
| `npm start -- '<guest URL>'` | Build if needed, then run local English host captions on generated video |
| `npm start -- '<guest URL>' --parakeet-model DIR` | Run captions with a different local model directory |

Build outputs are ignored by Git. `npm start` automatically builds the SDK first,
then the example, before launching. TypeScript's incremental cache skips unchanged
code. This also works with `npm start -w example-app` or from inside `example-app/`.
`npm run build` is available for an explicit build without running the CLI.

## Run the example app

```sh
npm start -- 'https://capture.example.com/sessions/248208?roomId=ROOM_ID&g=GUEST_TOKEN' --name 'AI assistant'
```

The sample placeholders are not valid credentials. Quote the full URL so the shell
does not interpret `&`. Guest URLs are credentials; avoid shared shell history and
process listings. Connection logs omit invitation/session credentials and raw
snapshots. Transcript output contains recognized host speech and may be sensitive.

The CLI extracts:

```text
baseUrl:   https://capture.example.com
sessionId: 248208
roomId:    ROOM_ID
guestToken:GUEST_TOKEN
```

It exchanges the invitation at `POST <baseUrl>/api/rooms/v2/join-room`, connects
to `<baseUrl>/api/live/ws` using WS(S), sends `join`, then `knock`. It prints the
actual area and role returned by the server, not an assumed admission. Ctrl+C or
SIGTERM sends `leave` with `close:false`; it never closes the host's room.
Local host captions are always enabled. The default model directory is
`models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8` inside this checkout.
Every completed host utterance is printed to stdout as JSON:

```json
{"event":"transcript","participantId":"host-id","text":"Hello everyone."}
```

Operational logs go to stderr. Guest audio is not transcribed or printed.

Options:

| Option | Meaning |
|---|---|
| `--name NAME` | Participant display name, default `AI agent` |
| `--device-id UUID` | Reuse the device ID printed by a previous run |
| `--rooms-url URL` | Override the complete invitation-exchange endpoint |
| `--ws-url URL` | Override the complete modern Live WebSocket endpoint |
| `--ice-url URL` | Override the complete ICE configuration HTTP endpoint |
| `--parakeet-model DIR` | Override the local English Parakeet TDT v2 INT8 directory |
| `--stt-threads N` | CPU inference threads, default `2`, allowed `1`–`16` |

Relative model overrides are resolved from the directory where you invoked the
command, including when npm runs the example workspace from a different directory.

The default routes target a same-origin deployment, including any path
prefix before `/sessions`. Other Shutter/local deployments can supply endpoint
overrides. This is the modern Live protocol, **not** Collider's `register` protocol.
Like Photo Session App, the SDK uses its configured Live endpoint rather than
trusting the Rooms response's potentially legacy `ws.url`.

The numeric route session ID is parsed for identification. Rooms authenticates
using `roomId` and `g`; no Dashboard login, cookie injection, or fabricated
`userId|deviceId` credentials are required. The client does not need
the browser's session-details request, which is used for UI metadata.

## Use the SDK

```ts
import { LiveSessionClient, parseGuestUrl } from "@shutter-studio/live-session-sdk";

const client = new LiveSessionClient(process.env.SESSION_GUEST_URL!, {
  name: "AI assistant",
  logger: ({ level, operation }) => console.error(level, operation),
});
client.onEvent(({ type, participantId }) => {
  console.log(type, participantId); // Do not print raw credential-bearing snapshots.
});

try {
  await client.connect(); // HTTP invite exchange, then WebSocket join into Setup
  const room = await client.knock();
  console.log(room.area, room.self.r);
  // The connection stays open, with protocol heartbeats, until disconnect().
} catch (error) {
  client.disconnect();
  throw error;
}
process.once("SIGINT", () => client.disconnect());
```

The example workspace resolves this import through npm's local workspace link.
For another local project, install the SDK directory with
`npm install /absolute/path/to/live-session-sdk/sdk` after building the SDK.

`snapshot` exposes the latest room snapshot; `onEvent` returns an unsubscribe
function. Direct notifications and `{event:{type,data}}` messages are normalized
to `{type,data,participantId?}`. `publish(type,data,recipientId?)` sends participant
events only while in Live. Publish has no acknowledgement; sending is not proof
that the recipient acted. Room closure, duplicate-session notifications, malformed
JSON, transport errors and heartbeat timeouts stop the connection and pending RPCs.
HTTP redirects are not followed. No command or invitation exchange is automatically
retried; a client instance is single-use. Reuse `deviceId` in a new client when
appropriate, rather than creating another anonymous participant on every attempt.

## Generated media

The example always starts captioned media. SDK consumers can start media
explicitly using `startSyntheticMedia()`:

```sh
npx playwright install chromium
npm start -- '<guest URL>'
```

Linux hosts also need Chromium's system libraries. On supported distributions,
`npx playwright install --with-deps chromium` installs them (requires administrator
access). Media startup fails with an error if Chromium cannot launch.

Node owns authentication and Live WebSocket signaling. Chromium draws animated
1280×720 Matrix-style terminal video at 15 fps and publishes a live microphone track containing
digital silence through Web Audio. No physical microphone is acquired and no
white-noise generator is present. It sends browser-native WebRTC directly to remote
participants; Playwright carries signaling and, when captioning is enabled,
incoming host PCM for local recognition. No physical camera,
microphone or local speaker output is required.

The video uses a black/green palette, falling code, high-contrast monospace
captions and a host-audio level history. A persistent `LIVE / LISTENING` badge
stays visible while host PCM arrives, including silent frames and after captions
are displayed. Its solid dot never blinks off; only the surrounding halo pulses.
Missing host audio, absent hosts and transcription failures show distinct
`AUDIO WAIT`, `WAITING FOR HOST` and `STT OFFLINE` states. The badge stops claiming
to listen if no audio frames arrive for 1.5 seconds.
Reduced-motion settings disable the falling-code animation and halo pulse while
keeping the live indicator visible. Rendering uses local system monospace fonts
and canvas drawing, with no external fonts or image assets.
Video sender settings prioritize 720p resolution over frame rate when adapting
to CPU or bandwidth limits, with a 3 Mbps bitrate ceiling.

The worker speaks Photo Session App's modern `webrtc.p2p.*` protocol, initiates
offers for existing non-legacy participants, and answers incoming offers.
It does not implement Collider or LiveKit transport.
ICE configuration comes from `POST <baseUrl>/api/legacy-rooms/ice`, using the
invitation exchange's session access token. Override it with `--ice-url`.

SDK callers can prepare media in Setup before knocking, or start it in Live:

```ts
await client.connect();
await client.startSyntheticMedia(); // Optional { iceUrl } or { iceServers }.
await client.knock();
// Later: await client.stopSyntheticMedia(); // Keeps signaling connected.
client.disconnect(); // Also starts worker cleanup.
```

`startSyntheticMedia()` waits for Chromium and the generators to start, not for
remote WebRTC connectivity. `stopSyntheticMedia()` waits for worker shutdown.
Disconnect, room closure and duplicate-session notifications also stop the worker.
Chromium adds startup time, download size and process memory; SDK-only signaling usage
does not launch it.

## Local English captions

Run the example. No separate model installation is required:

```sh
npm start -- '<guest URL>'
```

Before any invitation exchange or room membership change, the CLI downloads
missing English Parakeet TDT 0.6B v2 INT8 files into the default model directory
(or `--parakeet-model DIR`). It prints progress, streams downloads to temporary
files, verifies pinned SHA-256 digests and byte sizes, then publishes each verified
file atomically. Ctrl+C cancels the download and removes its temporary file.
Network, verification or disk failures stop startup without joining the room.

Existing nonempty local files are preserved and reused without network requests;
they are not rehashed on every run. This also permits compatible custom local
models. New downloads use the pinned
[sherpa-onnx conversion](https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8/tree/84b478d541cdbf0c296a7ab5f1e20a6f8f998114)
of [NVIDIA's Parakeet model](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2),
licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

Captions are the example app's only mode. macOS Intel and Apple Silicon use the
platform binaries selected by npm. Use a Node version
matching your architecture and a macOS version supported by Playwright. No source
edits, Python, archive utilities or OS-specific runtime flags are needed.

The directory must contain `encoder.int8.onnx`, `decoder.int8.onnx`,
`joiner.int8.onnx` and `tokens.txt` (about 661 MB total). Models stay outside Git.
Downloading finishes before the session starts. Do not use `npm ci --omit=optional` if you
run the example; it omits sherpa-onnx and its native platform binary.
SDK-only signaling and generated media without transcription still work without
this optional dependency.

SDK equivalent:

```ts
import { ensureParakeetModel } from "@shutter-studio/live-session-sdk";

const modelDirectory = "./models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8";
await ensureParakeetModel(modelDirectory); // Explicit SDK provisioning; the CLI does this automatically.
await client.connect();
await client.startSyntheticMedia({
  transcription: {
    modelDirectory,
    numThreads: 2,
    onTranscript: ({ participantId, text }) => console.log(participantId, text),
  },
});
await client.knock();
```

Only a non-legacy remote participant with server role `Host` is transcribed.
Guest tracks and the silent outgoing microphone track are excluded. If no host is
present, the video shows a waiting state. Host departure clears captions and
discards unfinished audio. This is role selection, not speaker diarization.

Chromium extracts mono 16 kHz PCM in 100 ms chunks using an AudioWorklet.
An energy gate ends speech after 600 ms of silence and splits continuous speech
at eight seconds. Parakeet performs local CPU inference in a worker thread; the
main thread keeps signaling and video running. Captions show the latest recognized
utterance, wrapped into up to five lines over the generated video. They appear
after speech pauses or a chunk fills, not word-by-word. Quiet speech may be missed;
noise may trigger the energy gate. Recognition is not guaranteed accurate.

At most one utterance is decoding and one is waiting. If inference falls behind,
the oldest waiting utterance is replaced and `stt.audio.dropped` is logged.
Disconnect and media stop terminate the inference worker. Audio is not saved to
disk. The CLI prints completed host transcripts; SDK callers receive them through
the optional `transcription.onTranscript` callback. The app does not write
transcript files, but terminal capture or redirected stdout can retain them.
No cloud STT request is made.
The captioned video is sent to all connected media peers, so its text is visible
to session participants.

## Limits and session impact

- No physical device capture, recording upload, LiveKit transport, or agent
  reasoning loop. The example always captions host audio; SDK consumers opt into
  media and transcription separately.
- **Guest only.** The backend currently has Host and Guest roles, not a secondary
  Producer capability. This package does not change permissions or expose
  start/stop-recording helpers.
- Joining changes room membership. A third participant can upgrade a P2P room to
  GROUP. Being in Live can count toward the server's session-start condition.
- **Do not leave this agent in a production room when starting a recording.**
  The current server creates recording Tracks for participants; this SDK cannot
  upload its assigned Track, so the Recording can remain incomplete.
- No automatic reconnect/resume. Unexpected disconnects exit the CLI nonzero.
- A successful signaling join is not proof of media delivery or producer
  control. Local verification does not certify deployed TURN/network behavior.

## Test

```sh
npm run install:chromium
npm test
```

SDK tests run real loopback HTTP/WebSocket peers. There are no CLI tests.
They cover parsing, invitation exchange/device metadata, returned identity,
correlation (including numeric reply IDs and `knock` replies named `join`),
admission states, heartbeats/timeouts, events, addressed publishing, shutdown,
rejections, redirects, and credential-free SDK logs.
Media tests use real local Chromium peers to check received microphone RTP with
zero source audio energy and only codec-level decoded noise below -80 dBFS, changing
video frames, outbound RTP stats, incoming offers and worker shutdown.
Download tests use real loopback HTTP to verify first-run installation, offline
reuse, checksum/size rejection, cancellation and preservation of unrelated files.
Renderer tests verify 720p capture, persistent live status during silence and
caption updates, stale-audio detection, host departure, errors and reduced motion.

Shared fixtures:

| Fixture | Boundary |
|---|---|
| `sdk/test/fixture.mjs` | Capturing Rooms HTTP and Live WebSocket server |
| `sdk/test/media-fixture.mjs` | Live signaling stub with real Chromium media endpoints |
| `sdk/test/download-fixture.mjs` | Local model-artifact HTTP server |
| `sdk/test/video-fixture.mjs` | Real Chromium renderer driven by explicit session/audio states |

Full local-model verification (macOS/Linux):

```sh
mkdir -p models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8/test_wavs
curl --fail --location \
  https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8/resolve/84b478d541cdbf0c296a7ab5f1e20a6f8f998114/test_wavs/0.wav \
  --output models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8/test_wavs/0.wav
PARAKEET_MODEL_DIR="$PWD/models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8" npm test
```

This optional public speech sample is only for integration tests, not CLI startup.
The model files must already be provisioned by the CLI or `ensureParakeetModel()`.
Without this variable, the three model-dependent integration tests are skipped.
With it, the model's included `test_wavs/0.wav` verifies real recognized words and
is sent through a real WebRTC peer to Parakeet; caption pixels are checked in the
remote-decoded video. A separate test verifies that received Guest audio never enters the transcription path.
The default suite checks speech endpointing and missing-model errors without
requiring model downloads. There are still no CLI tests.

The current server's `knock` enters Live directly and replies with `cmd:"join"`;
ping requires both `ts` and `latency`.

## Secret scanning

[Betterleaks](https://github.com/betterleaks/betterleaks) 1.10.1 scans source,
staged changes and Git history. It is a development tool, not an SDK runtime
dependency. Install that release on your `PATH`, or use
[mise](https://mise.jdx.dev/getting-started.html) with the included `mise.toml`:

```sh
mise trust
mise install
mise exec -- npm run secrets:scan
mise exec -- npm run secrets:history
mise exec -- npm run secrets:staged
```

Without mise, the same `npm run secrets:*` commands work when `betterleaks` 1.10.1
and Node are on `PATH`. To enable the optional local pre-commit hook:

```sh
npm run hooks:install
```

This sets this checkout's `core.hooksPath` to `.githooks`; the hook requires npm
and Betterleaks on `PATH` (or run Git through `mise exec -- git commit`).
It blocks commits with detected secrets. It is not installed automatically by
`npm ci`.

`.betterleaks.toml` extends the built-in detectors and adds detection for guest
invitation UUIDs in `g=` URL parameters. Dependencies, downloaded `models/`,
generated output and Git internals are excluded, not SDK tests or documentation.
Commands redact findings, exit nonzero on leaks and disable live credential
validation. No scanner can prove that every credential is absent.

Secret scanning runs locally. This repository has no GitHub Actions workflows.
