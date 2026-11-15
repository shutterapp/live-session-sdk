import test from "node:test";
import assert from "node:assert/strict";
import { ParakeetTranscriber } from "../dist/parakeet.js";

test("a missing local model fails clearly without downloading anything", async t => {
  const stt = new ParakeetTranscriber({ modelDirectory: new URL("./missing-parakeet-model/", import.meta.url).pathname }, () => {});
  t.after(() => stt.stop());

  await assert.rejects(stt.start(), {
    message: "Unable to load local Parakeet; check model files and optional sherpa-onnx-node installation",
  });
});

test("invalid CPU thread counts are rejected before creating a worker", () => {
  assert.throws(() => new ParakeetTranscriber({ modelDirectory: ".", numThreads: 0 }, () => {}),
    { message: "STT threads must be between 1 and 16" });
});
