import { test } from "node:test";
import assert from "node:assert/strict";
import { LiveSessionClient } from "../dist/index.js";
import { sessionServer, snapshot, self } from "./fixture.mjs";

test("exchanges the guest invitation and joins with returned credentials, not the guest token", async t => {
  // Arrange
  const peer = await sessionServer(t);
  const logs = [];
  const client = new LiveSessionClient(peer.guestUrl, { name: "Producer assistant", deviceId: "remembered", logger: e => logs.push(e) });
  t.after(() => client.disconnect());

  // Act
  const room = await client.connect();

  // Assert
  assert.deepEqual(room, snapshot);
  assert.equal(client.deviceId, "device-agent");
  assert.deepEqual(peer.requests.map(r => [r.method, r.path, r.body]), [[
    "POST", "/api/rooms/v2/join-room", {
      roomId: "room-a", joinToken: "private-guest-token", deviceId: "remembered",
      device: {
        id: "remembered", platform: { implementation: "live-session-sdk", platform: "Node.js" },
        screenSize: { w: 0, h: 0 }, cameras: { defaultCamera: "", cameras: [] },
      },
    },
  ]]);
  assert.deepEqual(peer.messages, [{ cmd: "join", mid: "1", room: "room-a", creds: "201|9", name: "Producer assistant" }]);
  assert.doesNotMatch(JSON.stringify(logs), /private-|201\|9/);
});

test("knock accepts cmd=join and numeric rid and returns the server's Live area", async t => {
  const peer = await sessionServer(t, { numericRid: true });
  const client = new LiveSessionClient(peer.guestUrl);
  t.after(() => client.disconnect());
  await client.connect();

  const room = await client.knock();

  assert.equal(room.area, "Live");
  assert.deepEqual(room.pts, [self]);
  assert.deepEqual(peer.messages.at(-1), { cmd: "knock", mid: "2" });
});

test("keeps WaitingRoom when the server does not admit the guest", async t => {
  const peer = await sessionServer(t, { waiting: true });
  const client = new LiveSessionClient(peer.guestUrl);
  t.after(() => client.disconnect());
  await client.connect();

  const room = await client.knock();

  assert.equal(room.area, "WaitingRoom");
});

test("normalizes wrapped recording events and exposes remote participant state", async t => {
  const peer = await sessionServer(t);
  const client = new LiveSessionClient(peer.guestUrl);
  t.after(() => client.disconnect());
  await client.connect();
  const received = new Promise(resolve => client.onEvent(e => { if (e.type === "recording.started") resolve(e); }));

  peer.send({ event: { type: "recording.started", data: { id: "42", tracks: {} } } });
  const event = await received;

  assert.deepEqual(event, { type: "recording.started", data: { id: "42", tracks: {} } });
  assert.deepEqual(client.snapshot.recording, { id: "42", tracks: {} });
});

test("publishes addressed participant events without waiting for a nonexistent acknowledgement", async t => {
  const peer = await sessionServer(t);
  const client = new LiveSessionClient(peer.guestUrl);
  t.after(() => client.disconnect());
  await client.connect();
  await client.knock();
  const published = peer.waitFor("pub");

  client.publish("agent.status", { state: "observing" }, "100|1");

  assert.deepEqual(await published, {
    cmd: "pub", mid: "3", type: "agent.status", cid: "100|1", data: { state: "observing" },
  });
});

test("refuses publishing before Live instead of reporting a silently dropped message as sent", async t => {
  const peer = await sessionServer(t);
  const client = new LiveSessionClient(peer.guestUrl);
  t.after(() => client.disconnect());
  await client.connect();

  assert.throws(() => client.publish("agent.status", {}), /must be in Live/);
  assert.equal(peer.messages.length, 1);
});

test("heartbeats include timestamp and integer latency required by the actual handler", async t => {
  const peer = await sessionServer(t);
  const client = new LiveSessionClient(peer.guestUrl, { heartbeatMs: 20 });
  t.after(() => client.disconnect());
  const ping = peer.waitFor("ping");
  await client.connect();

  const message = await ping;

  assert.equal(message.cmd, "ping");
  assert.equal(typeof message.ts, "number");
  assert.equal(message.latency, 0);
});

test("leave never closes the host's room", async t => {
  const peer = await sessionServer(t);
  const client = new LiveSessionClient(peer.guestUrl);
  await client.connect();
  const leave = peer.waitFor("leave");

  client.disconnect();

  assert.deepEqual(await leave, { cmd: "leave", mid: "2", close: false });
});

test("server room closure stops the client and emits its notification", async t => {
  const peer = await sessionServer(t);
  const client = new LiveSessionClient(peer.guestUrl);
  t.after(() => client.disconnect());
  await client.connect();
  const closed = new Promise(resolve => client.onEvent(e => { if (e.type === "room.closed") resolve(e); }));

  peer.send({ type: "room.closed", data: {} });
  await closed;

  await assert.rejects(() => client.knock(), /not joined/);
});

test("duplicate-session stops the client without silently rejoining another participant's session", async t => {
  const peer = await sessionServer(t);
  const client = new LiveSessionClient(peer.guestUrl);
  t.after(() => client.disconnect());
  await client.connect();
  const closed = new Promise(resolve => client.onEvent(e => { if (e.type === "duplicate-session") resolve(e); }));

  peer.send({ type: "duplicate-session" });
  await closed;

  await assert.rejects(() => client.knock(), /not joined/);
  assert.equal(peer.requests.length, 1);
});

test("malformed JSON stops the connection without logging its raw contents", async t => {
  const peer = await sessionServer(t);
  const logs = [];
  const client = new LiveSessionClient(peer.guestUrl, { logger: e => logs.push(e) });
  t.after(() => client.disconnect());
  await client.connect();
  const closed = new Promise(resolve => client.onEvent(e => { if (e.type === "disconnected") resolve(e); }));

  peer.raw("{broken");
  await closed;

  assert.ok(logs.some(e => e.operation === "protocol.invalid-json"));
  assert.doesNotMatch(JSON.stringify(logs), /broken/);
  await assert.rejects(() => client.knock(), /not joined/);
});

test("participant join and leave notifications maintain the visible membership snapshot", async t => {
  const peer = await sessionServer(t);
  const client = new LiveSessionClient(peer.guestUrl);
  t.after(() => client.disconnect());
  await client.connect();
  const joined = new Promise(resolve => client.onEvent(e => { if (e.type === "room.joined") resolve(e); }));
  peer.send({ type: "room.joined", data: { ...self, cid: "300|10", uid: 300, did: 10 } });
  await joined;
  assert.equal(client.snapshot.pts[0].cid, "300|10");
  const left = new Promise(resolve => client.onEvent(e => { if (e.type === "room.left") resolve(e); }));

  peer.send({ type: "room.left", data: { cid: "300|10" } });
  await left;

  assert.deepEqual(client.snapshot.pts, []);
});

for (const [scenario, options, expected] of [
  ["HTTP invitation rejection", { httpStatus: 403 }, /HTTP 403/],
  ["malformed credentials", { invalidCredentials: true }, /invalid participant credentials/],
  ["Live rejection", { joinError: true }, /rejected by the server/],
  ["malformed room snapshot", { malformedSnapshot: true }, /invalid room snapshot/],
  ["missing join response", { silentJoin: true }, /response timed out/],
  ["redirected exchange", { redirect: true }, /invitation exchange failed/],
]) {
  test(`${scenario} fails the connection without exposing secrets`, async t => {
    const peer = await sessionServer(t, options);
    const client = new LiveSessionClient(peer.guestUrl, { timeoutMs: 150 });
    t.after(() => client.disconnect());

    await assert.rejects(() => client.connect(), error => expected.test(error.message) && !error.message.includes("private-"));
  });
}

test("heartbeat timeout reconnects and resumes the existing session", { timeout: 10_000 }, async t => {
  const peer = await sessionServer(t, { silentPing: true });
  const logs = [];
  const client = new LiveSessionClient(peer.guestUrl, { heartbeatMs: 20, timeoutMs: 150, logger: e => logs.push(e) });
  t.after(() => client.disconnect());
  await client.connect();
  const resumed = new Promise(resolve => client.onEvent(e => { if (e.type === "joined") resolve(e); }));
  const resume = peer.waitFor("resume");

  await resumed;

  assert.ok(logs.some(e => e.operation === "heartbeat.failed"));
  assert.deepEqual(await resume, { cmd: "resume", mid: "3", sid: snapshot.sid });
  assert.equal(peer.requests.length, 1);
});

test("transport closure resumes Live without another invitation exchange or knock", { timeout: 10_000 }, async t => {
  const peer = await sessionServer(t, { numericRid: true });
  const client = new LiveSessionClient(peer.guestUrl);
  t.after(() => client.disconnect());
  await client.connect();
  await client.knock();
  const resumed = new Promise(resolve => client.onEvent(e => { if (e.type === "joined") resolve(e); }));
  const resume = peer.waitFor("resume");

  peer.close();
  await resumed;

  assert.deepEqual(await resume, { cmd: "resume", mid: "3", sid: snapshot.sid });
  assert.equal(client.snapshot.area, "Live");
  assert.equal(peer.requests.length, 1);
  assert.equal(peer.messages.filter(m => m.cmd === "join").length, 1);
});
