# Live Session SDK examples

Run these commands from the repository root with Node.js 22+ and npm 10+. Install dependencies once with `npm ci`.

## Create a session and print its guest URL

Copy the [sample](.env.sample) to `examples/.env`:

```sh
cp examples/.env.sample examples/.env
```

In `examples/.env`, set `STUDIO_BASE_URL` to your deployment’s HTTPS URL and `STUDIO_API_TOKEN` to your Dashboard API key.

```sh
npm run build -w sdk
node --env-file=examples/.env examples/create-session.mjs "Portrait"
```

Each run creates a new session and prints its guest invitation URL to stdout. Share that URL with the intended guest.

## Run the producer agent

The [producer agent](producer-agent/) takes a guest URL as its argument. It joins the session and captions host speech.

```sh
npm run install:chromium
npm start -- '<guest URL>'
```

Press Ctrl+C to leave the room.
