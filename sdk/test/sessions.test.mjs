import { test } from "node:test";
import assert from "node:assert/strict";
import { LiveSessionClient } from "../dist/index.js";
import { sessionServer, snapshot } from "./fixture.mjs";

test("create and share an invite using Dashboard HTTP alone", async t => {
  const url = "https://capture.example.com/sessions/17?roomId=studio-room&g=guest";
  const peer = await sessionServer(t, { responses: {
    "/api/v1/platform/sessions": { shootId: "42", sessionId: "17", roomId: "studio-room", roomUrl: null },
    "/api/v1/platform/shoots/42": { guestShareUrl: url },
  } });
  const client = new LiveSessionClient({ baseUrl: peer.baseUrl, apiToken: "test-key" });
  const session = await client.createSession("Portrait");
  assert.equal(await client.getGuestInviteUrl(session.shootId), url);
  assert.deepEqual(peer.requests.map(r => [r.method, r.path, r.headers.authorization]), [
    ["POST", "/api/v1/platform/sessions", "Bearer test-key"], ["GET", "/api/v1/platform/shoots/42", "Bearer test-key"],
  ]);
  assert.equal(peer.requests[0].body.inviteSubjectLater, true);
  assert.deepEqual(peer.messages, []);
});

const hostResponse = { session: { role: "host" }, ws: { token: "server-issued" } };
test("host joins with an explicit base URL, room ID and API token", async t => {
  const peer = await sessionServer(t, { responses: { "/api/rooms/v2/join-room": hostResponse },
    joinSnapshot: { ...snapshot, self: { ...snapshot.self, r: "Host" } } });
  const client = new LiveSessionClient({ baseUrl: peer.baseUrl, apiToken: "test-key" });
  t.after(() => client.close());
  const room = await client.joinAsHost("studio-room");
  assert.equal(room.area, "Live");
  assert.equal(room.self.r, "Host");
  assert.equal(peer.requests[0].headers.authorization, "Bearer test-key");
  assert.equal(peer.requests[0].body.roomId, "studio-room");
  assert.equal("joinToken" in peer.requests[0].body, false);
  assert.equal(peer.messages[0].creds, "server-issued");
  assert.equal(peer.messages[0].room, "studio-room");
  assert.ok(!JSON.stringify(peer.messages).includes("test-key"));
});

test("joinAsGuest returns the server's waiting-room decision", async t => {
  const peer = await sessionServer(t, { waiting: true });
  const client = new LiveSessionClient({ name: "Visitor", baseUrl: "https://studio.example", apiToken: "host-only" });
  t.after(() => client.close());

  const room = await client.joinAsGuest(peer.guestUrl);

  assert.equal(room.area, "WaitingRoom");
  assert.equal(room.self.r, "Guest");
  assert.equal(peer.messages[0].name, "Visitor");
  assert.equal(peer.requests[0].headers.authorization, undefined);
});

test("host join rejects a Guest role from Live", async t => {
  const peer = await sessionServer(t, { responses: { "/api/rooms/v2/join-room": hostResponse } });
  const client = new LiveSessionClient({ baseUrl: peer.baseUrl, apiToken: "test-key", sessionId: "17", roomId: "studio-room" });
  await assert.rejects(client.connect(), /Host access/);
});

test("Host closes the room with a single leave command before disconnecting", async t => {
  const peer = await sessionServer(t, { responses: { "/api/rooms/v2/join-room": hostResponse },
    joinSnapshot: { ...snapshot, self: { ...snapshot.self, r: "Host" } } });
  const client = new LiveSessionClient({ baseUrl: peer.baseUrl, apiToken: "test-key" });
  await client.joinAsHost("studio-room");
  const leave = peer.waitFor("leave");

  client.closeRoom();
  await client.close();

  assert.equal((await leave).close, true);
  assert.deepEqual(peer.messages.map(m => m.cmd), ["join", "knock", "leave"]);
});
