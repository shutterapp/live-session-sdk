import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { videoFixture } from "./video-fixture.mjs";

test("Matrix video is native 720p and waits for a host without claiming to listen", async t => {
  const video = await videoFixture(t);

  const settings = await video.page.evaluate(() => window.shutterVideo.track.getSettings());

  assert.equal(settings.width, 1280);
  assert.equal(settings.height, 720);
  assert.equal(await video.canvas.getAttribute("data-status"), "waiting");
  assert.match(await video.canvas.getAttribute("aria-label"), /WAITING FOR HOST/);
});

test("the solid LIVE indicator stays visible during silence and after captions arrive", async t => {
  const video = await videoFixture(t);

  for (const caption of ["", "The signal is clear.", "We are still listening after the transcript appears."]) {
    await video.update({ hostPresent: true, listening: true, level: 0, caption });
    await delay(150);
    const [red, green, blue] = await video.core();

    assert.equal(await video.canvas.getAttribute("data-status"), "listening");
    assert.match(await video.canvas.getAttribute("aria-label"), /LIVE \/ LISTENING/);
    assert.ok(green > 200 && green > red * 2 && green > blue * 1.5);
  }
});

test("losing audio frames stops the LIVE claim without discarding the last caption", async t => {
  const video = await videoFixture(t);
  await video.update({ hostPresent: true, listening: true, caption: "Last recognized words." });

  await video.page.waitForFunction(() =>
    document.querySelector('[data-testid="agent-video-output"]').dataset.status === "connecting");

  assert.match(await video.canvas.getAttribute("aria-label"), /AUDIO WAIT.*Last recognized words/);
});

test("host departure clears the transcript and listening indicator", async t => {
  const video = await videoFixture(t);
  await video.update({ hostPresent: true, listening: true, caption: "Previous host words." });

  await video.update({ hostPresent: false });

  assert.equal(await video.canvas.getAttribute("data-status"), "waiting");
  assert.doesNotMatch(await video.canvas.getAttribute("aria-label"), /LIVE \/ LISTENING|Previous host words/);
});

test("transcription failure shows an offline state instead of LIVE", async t => {
  const video = await videoFixture(t);
  await video.update({ hostPresent: true, listening: true });

  await video.update({ transcriptionAvailable: false });

  assert.equal(await video.canvas.getAttribute("data-status"), "error");
  assert.match(await video.canvas.getAttribute("aria-label"), /STT OFFLINE/);
});

test("reduced motion keeps Matrix decoration static without hiding LIVE", async t => {
  const video = await videoFixture(t, { reducedMotion: "reduce" });
  await video.update({ hostPresent: true, listening: true, caption: "The signal is clear." });
  const first = await video.frame();

  await delay(200);
  const second = await video.frame();

  assert.equal(second, first);
  assert.equal(await video.canvas.getAttribute("data-status"), "listening");
});
