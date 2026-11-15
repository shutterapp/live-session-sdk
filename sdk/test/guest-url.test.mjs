import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGuestUrl } from "../dist/index.js";

test("extracts base URL, session ID, room ID and guest credential", () => {
  const address = parseGuestUrl("https://capture.example.com/sessions/248208?roomId=WEzOMFA&g=test-guest");
  assert.deepEqual(address, {
    baseUrl: "https://capture.example.com", sessionId: "248208", roomId: "WEzOMFA", guestToken: "test-guest",
  });
});

test("retains the deployment path and port before /sessions and decodes query parameters", () => {
  const address = parseGuestUrl("http://localhost:8880/capture/sessions/123/?roomId=a%2Bb&g=abc%2B123");
  assert.deepEqual(address, {
    baseUrl: "http://localhost:8880/capture", sessionId: "123", roomId: "a+b", guestToken: "abc+123",
  });
});

for (const [scenario, url] of [
  ["relative URL", "/sessions/1?roomId=r&g=secret"],
  ["wrong protocol", "file:///sessions/1?roomId=r&g=secret"],
  ["userinfo", "https://name:secret@example.com/sessions/1?roomId=r&g=secret"],
  ["missing guest token", "https://example.com/sessions/1?roomId=r"],
  ["empty room", "https://example.com/sessions/1?roomId=&g=secret"],
  ["duplicate guest token", "https://example.com/sessions/1?roomId=r&g=secret&g=another"],
  ["duplicate room", "https://example.com/sessions/1?roomId=r&roomId=s&g=secret"],
  ["missing session ID", "https://example.com/sessions/?roomId=r&g=secret"],
  ["non-numeric session ID", "https://example.com/sessions/new?roomId=r&g=secret"],
  ["fragment", "https://example.com/sessions/1?roomId=r&g=secret#secret"],
]) {
  test(`rejects ${scenario} without printing credentials`, () => {
    assert.throws(() => parseGuestUrl(url), error => !error.message.includes("secret"));
  });
}
