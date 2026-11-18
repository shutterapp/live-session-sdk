import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveSessionClient } from "../dist/index.js";
import { sessionServer, self } from "./fixture.mjs";
import { testSourceScript } from "./test-source.mjs";

test("shutdown flushes the local A/V recording and waits for multipart finalization", { timeout: 25_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "studio-recording-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const chunks = [], paths = [];
  const first = Promise.withResolvers(), finalizing = Promise.withResolvers(), acknowledge = Promise.withResolvers();
  const server = await sessionServer(t, { upload: async (req, res) => {
    paths.push(`${req.method} ${req.url}`);
    if (req.method === "PATCH") {
      finalizing.resolve();
      await acknowledge.promise;
    } else {
      const body = [];
      for await (const bytes of req) body.push(bytes);
      chunks.push(Buffer.concat(body));
      first.resolve();
    }
    res.writeHead(200).end();
  } });
  const client = new LiveSessionClient(server.guestUrl);
  await client.connect();
  await client.knock();
  await client.startMedia({ sourceScript: testSourceScript, iceServers: [], recordingDirectory: dir });
  server.send({ event: { type: "recording.started", data: { id: "42", tracks: {
    [self.cid]: { trackId: "15", uploadUid: "my-track" },
    "999|1": { trackId: "16", uploadUid: "other-track" },
  } } } });
  await first.promise;

  let closed = false;
  const closing = client.close().then(() => { closed = true; });
  try {
    await finalizing.promise;
    assert.equal(closed, false);
    const local = await readFile(join(dir, "my-track.webm"));
    assert.deepEqual(Buffer.concat(chunks), local);
    assert.equal(local.readUInt32BE(0), 0x1a45dfa3);
    assert.ok(local.includes(Buffer.from("A_OPUS")));
    assert.match(local.toString("latin1"), /V_(VP8|VP9|AV1)/);
    assert.deepEqual(paths, [
      ...chunks.map((_, i) => `PUT /api/media/v2/uploads/my-track/${i + 1}_unknown.part`),
      "PATCH /api/media/v2/uploads/my-track/finalize",
    ]);
  } finally {
    acknowledge.resolve();
    await closing;
  }
});
