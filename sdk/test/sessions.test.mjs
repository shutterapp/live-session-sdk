import { test } from "node:test";
import assert from "node:assert/strict";
import { createSession, getGuestInviteUrl, LiveSessionClient } from "../dist/index.js";
import { sessionServer, snapshot } from "./fixture.mjs";

test("create and share an invite using Dashboard HTTP alone", async t => {
  const url = "https://capture.example.com/sessions/17?roomId=studio-room&g=guest";
  const peer = await sessionServer(t, { responses: {
    "/api/v1/platform/sessions": { shootId: "42", sessionId: "17", roomId: "studio-room", roomUrl: null },
    "/api/v1/platform/shoots/42": { guestShareUrl: url },
  } });
  const access = { baseUrl: peer.baseUrl, apiToken: "test-key" };
  const session = await createSession(access, "Portrait");
  assert.equal(await getGuestInviteUrl(access, session.shootId), url);
  assert.deepEqual(peer.requests.map(r => [r.method, r.path, r.headers.authorization]), [
    ["POST", "/api/v1/platform/sessions", "Bearer test-key"], ["GET", "/api/v1/platform/shoots/42", "Bearer test-key"],
  ]);
  assert.equal(peer.requests[0].body.inviteSubjectLater, true);
  assert.deepEqual(peer.messages, []);
});

const hostResponse = { session: { role: "host" }, ws: { token: "server-issued" } };
test("authenticated host exchange keeps the API token out of signaling", async t => {
  const peer = await sessionServer(t, { responses: { "/api/rooms/v2/join-room": hostResponse },
    joinSnapshot: { ...snapshot, self: { ...snapshot.self, r: "Host" } } });
  const client = new LiveSessionClient({ baseUrl: peer.baseUrl, apiToken: "test-key", sessionId: "17", roomId: "studio-room" });
  t.after(() => client.close());
  assert.equal((await client.connect()).self.r, "Host");
  assert.equal(peer.requests[0].headers.authorization, "Bearer test-key");
  assert.equal("joinToken" in peer.requests[0].body, false);
  assert.equal(peer.messages[0].creds, "server-issued");
  assert.ok(!JSON.stringify(peer.messages).includes("test-key"));
});

test("host join rejects a Guest role from Live", async t => {
  const peer = await sessionServer(t, { responses: { "/api/rooms/v2/join-room": hostResponse } });
  const client = new LiveSessionClient({ baseUrl: peer.baseUrl, apiToken: "test-key", sessionId: "17", roomId: "studio-room" });
  await assert.rejects(client.connect(), /Host access/);
});
