import { chromium } from "playwright";
import { installMatrixVideo } from "../dist/matrix-video.js";

// Real Chromium canvas renderer; state updates replace only live session input.
export async function videoFixture(t, options = {}) {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 }, reducedMotion: options.reducedMotion ?? "no-preference",
  });
  await page.evaluate(installMatrixVideo, { captioning: true });
  return {
    page,
    canvas: page.getByTestId("agent-video-output"),
    update: change => page.evaluate(change => window.shutterVideo.update(change), change),
    core: () => page.evaluate(() => {
      const canvas = document.querySelector('[data-testid="agent-video-output"]');
      return Array.from(canvas.getContext("2d").getImageData(874, 68, 1, 1).data);
    }),
    frame: () => page.evaluate(() => document.querySelector("canvas").toDataURL()),
  };
}
