import test from "node:test";
import assert from "node:assert/strict";
import { mediaPeer } from "./media-fixture.mjs";
import { sessionServer } from "./fixture.mjs";
import { LiveSessionClient } from "../dist/index.js";

test("Chromium publisher offers changing video and a live silent microphone track", { timeout: 25_000 }, async t => {
  const peer = await mediaPeer(t);
  peer.session.snapshot.pts = [{ cid: "remote" }];

  await peer.publisher.start();
  const received = await peer.received();
  await peer.flush();
  const [stats] = await peer.publisher.stats();

  assert.equal(stats.audioSourceEnergy, 0);
  assert.ok(received.audioRms < 0.0001, "Decoded audio must remain below -80 dBFS (Opus may add a noise floor)");
  assert.ok(received.audioBytes > 0);
  assert.ok(received.frames >= 5 && received.changing);
  assert.equal(received.width, 1280);
  assert.equal(received.height, 720);
  assert.equal(stats.state, "connected");
  assert.ok(stats.audioBytesSent > 0 && stats.videoBytesSent > 0 && stats.videoFramesEncoded > 0);
  assert.equal(peer.operations.some(row => row.error), false);
});

test("Chromium publisher answers an incoming participant with video and a silent microphone track", { timeout: 25_000 }, async t => {
  const peer = await mediaPeer(t);
  await peer.publisher.start();

  await peer.offer();
  const received = await peer.received();
  await peer.flush();
  const [stats] = await peer.publisher.stats();

  assert.equal(stats.audioSourceEnergy, 0);
  assert.ok(received.audioRms < 0.0001, "Decoded audio must remain below -80 dBFS (Opus may add a noise floor)");
  assert.ok(received.audioBytes > 0 && received.changing);
  assert.ok(peer.operations.some(row => row.operation === "media.answer.sent"));
  assert.equal(peer.operations.some(row => row.error), false);
});

test("stopping the SDK publisher closes Chromium while signaling remains usable", { timeout: 25_000 }, async t => {
  const server = await sessionServer(t);
  const operations = [];
  const client = new LiveSessionClient(server.guestUrl, { logger: entry => operations.push(entry.operation) });
  t.after(() => client.disconnect());
  await client.connect();
  await client.startSyntheticMedia({ iceServers: [] });
  await client.knock();

  await client.stopSyntheticMedia();
  const published = server.waitFor("pub");
  client.publish("test.after-media-stop", {});
  const message = await published;

  assert.ok(operations.includes("media.generators.started"));
  assert.ok(operations.includes("media.stopped"));
  assert.equal(client.snapshot.area, "Live");
  assert.equal(message.type, "test.after-media-stop");
});

test("failed SDK media startup closes its worker and permits another explicit start", { timeout: 25_000 }, async t => {
  const server = await sessionServer(t, {
    participants: [{ cid: "remote", uid: 202, did: 10, r: "Guest", p: { name: "Remote" } }],
  });
  const operations = [];
  const client = new LiveSessionClient(server.guestUrl, { logger: entry => operations.push(entry.operation) });
  t.after(() => client.disconnect());
  await client.connect();
  await client.knock();

  await assert.rejects(client.startSyntheticMedia({ iceServers: [{ urls: "invalid-scheme:private-ice-value" }] }),
    { message: "Unable to start synthetic media; install Playwright Chromium and check the ICE endpoint" });
  await client.startSyntheticMedia({ iceServers: [] });
  await client.stopSyntheticMedia();

  assert.equal(operations.filter(operation => operation === "media.stopped").length, 2);
  assert.ok(operations.includes("media.generators.started"));
});

test("stopping during Chromium startup completes cleanup", { timeout: 25_000 }, async t => {
  const peer = await mediaPeer(t);

  const startup = peer.publisher.start();
  await peer.publisher.stop();
  await startup;

  assert.deepEqual(await peer.publisher.stats(), []);
  assert.ok(peer.operations.some(row => row.operation === "media.stopped"));
});
