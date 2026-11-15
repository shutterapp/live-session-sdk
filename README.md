# Experimental Live Session SDK

Standalone TypeScript package for headless Node.js participants. No Angular
dependencies. Node 22+ supplies HTTP fetch and WebSocket. Playwright controls an
optional headless Chromium media worker; no native Node WebRTC addon is used.

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
- For synthetic media and the full test suite: Playwright's Chromium browser and
  its OS libraries. Supported Windows, macOS and Linux hosts are listed in
  [Playwright's system requirements](https://playwright.dev/docs/intro#system-requirements).
  Headless operation needs no display, physical camera or microphone.
- Internet access for npm/browser downloads. Live runs also need a valid guest
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
For signaling-only runs, skip the Chromium installation.
Run all commands below from the repository root.

| Command | Purpose |
|---|---|
| `npm ci` | Install locked dependencies and link the local workspaces |
| `npm run install:chromium` | Download the Chromium version matching Playwright |
| `npm run build` | Build SDK first, then the example app |
| `npm run build -w sdk` | Build only the SDK |
| `npm run build -w example-app` | Build only the example; SDK must already be built |
| `npm test` | Build the SDK and run its full test suite, including Chromium media |
| `npm start -- --help` | Show example CLI usage after building |
| `npm start -- '<guest URL>'` | Run the example as a signaling-only guest |
| `npm start -- '<guest URL>' --synthetic-media` | Run with generated audio/video |

Build outputs are ignored by Git. Rebuild after changing source.

## Run the example app

```sh
npm start -- 'https://capture.example.com/sessions/248208?roomId=ROOM_ID&g=GUEST_TOKEN' --name 'AI assistant'
```

The sample placeholders are not valid credentials. Quote the full URL so the shell
does not interpret `&`. Guest URLs are credentials; avoid shared shell history and
process listings. SDK and CLI logs omit tokens, session IDs used for resume,
raw messages, and LiveKit credentials.

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

Options:

| Option | Meaning |
|---|---|
| `--name NAME` | Participant display name, default `AI agent` |
| `--device-id UUID` | Reuse the device ID printed by a previous run |
| `--setup-only` | Join Setup without requesting entry to Live |
| `--rooms-url URL` | Override the complete invitation-exchange endpoint |
| `--ws-url URL` | Override the complete modern Live WebSocket endpoint |
| `--synthetic-media` | Publish generated test video and quiet white noise through Chromium |
| `--ice-url URL` | Override the complete ICE configuration HTTP endpoint |

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

Install Chromium once, then enable media explicitly:

```sh
npx playwright install chromium
npm start -- '<guest URL>' --synthetic-media
```

Linux hosts also need Chromium's system libraries. On supported distributions,
`npx playwright install --with-deps chromium` installs them (requires administrator
access). Media startup fails with an error if Chromium cannot launch.

Node owns authentication and Live WebSocket signaling. Chromium draws animated
640×360 color bars at 15 fps and loops ten seconds of quiet, uniformly distributed
white noise through Web Audio. It sends browser-native WebRTC directly to remote
participants; Playwright carries signaling, not media frames. No physical camera,
microphone or local speaker output is required.

The worker speaks Photo Session App's modern `webrtc.p2p.*` protocol, initiates
offers for existing non-legacy participants, and answers incoming offers.
It does not implement Collider or LiveKit transport.
ICE configuration comes from `POST <baseUrl>/api/legacy-rooms/ice`, using the
invitation exchange's session access token. Override it with `--ice-url`.
`--synthetic-media` cannot be combined with `--setup-only`.

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
Chromium adds startup time, download size and process memory; signaling-only usage
does not launch it.

## Limits and session impact

- No physical device capture, transcription, recording upload, LiveKit transport,
  or agent reasoning loop. Generated P2P media is opt-in.
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
Media tests use real local Chromium peers to check decoded audio energy, changing
video frames, outbound RTP stats, incoming offers and worker shutdown.

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
invitation UUIDs in `g=` URL parameters. Only dependencies, generated output and
Git internals are excluded, not SDK tests or documentation.
Commands redact findings, exit nonzero on leaks and disable live credential
validation. No scanner can prove that every credential is absent.

Secret scanning runs locally. This repository has no GitHub Actions workflows.
