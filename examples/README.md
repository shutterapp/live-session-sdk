# Live Session SDK examples

Run these commands from the repository root with Node.js 22+ and npm 10+. Install dependencies once with `npm ci`.

## Run the producer agent

Copy the [sample](.env.sample) to `examples/.env`:

```sh
cp examples/.env.sample examples/.env
```

In `examples/.env`, set `STUDIO_BASE_URL` to your deployment’s HTTPS URL and `STUDIO_API_TOKEN` to your Dashboard API key.

```sh
npm run install:chromium
npm run producer -- "Portrait"
```

Each run creates a new session, prints its guest invitation URL to stdout, then joins as Host. Press Ctrl+C to leave.

## Run the assistant agent

The [assistant agent](assistant-agent/) takes a guest URL as its argument. It joins the session and captions host speech.

When the host starts a recording, the assistant records its outgoing caption video and silent audio. It keeps the WebM in `examples/assistant-agent/recordings/` and uploads it to the session as the assistant's track.

```sh
npm run install:chromium
npm start -- '<guest URL>'
```

Press Ctrl+C to leave the room.
