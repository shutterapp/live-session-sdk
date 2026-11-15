import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { mediaPeer } from "./media-fixture.mjs";
import { ParakeetTranscriber } from "../dist/parakeet.js";

const modelDirectory = process.env.PARAKEET_MODEL_DIR;

test("local English Parakeet recognizes the supplied speech rather than returning placeholder text", {
  skip: !modelDirectory && "Set PARAKEET_MODEL_DIR to run real-model verification",
  timeout: 30_000,
}, async t => {
  const sherpa = createRequire(import.meta.url)("sherpa-onnx-node");
  const wave = sherpa.readWave(join(modelDirectory, "test_wavs/0.wav"));
  const result = Promise.withResolvers();
  const stt = new ParakeetTranscriber({ modelDirectory }, result.resolve);
  t.after(() => stt.stop());
  await stt.start();

  for (let offset = 0; offset < wave.samples.length; offset += 1600) {
    const samples = new Float32Array(1600);
    samples.set(wave.samples.subarray(offset, offset + 1600));
    stt.accept({ participantId: "host", sampleRate: 16000, samples });
  }
  for (let i = 0; i < 6; i++) {
    stt.accept({ participantId: "host", sampleRate: 16000, samples: new Float32Array(1600) });
  }
  const transcript = await result.promise;

  assert.equal(transcript.participantId, "host");
  assert.match(transcript.text, /I don't wish to see it any more/i);
});

test("local Parakeet captions host speech received over real WebRTC onto outgoing video", {
  skip: !modelDirectory && "Set PARAKEET_MODEL_DIR to run real-model verification",
  timeout: 60_000,
}, async t => {
  const sherpa = createRequire(import.meta.url)("sherpa-onnx-node");
  const wave = sherpa.readWave(join(modelDirectory, "test_wavs/0.wav"));
  const transcripts = [];
  const peer = await mediaPeer(t, { transcription: { modelDirectory, onTranscript: result => transcripts.push(result) } });
  peer.session.snapshot.pts = [{ cid: "remote", r: "Host" }];
  await peer.prepareAudio(wave.samples, wave.sampleRate);
  await peer.publisher.start();
  await peer.received();
  const baseline = await peer.captionPixels();

  await peer.playAudio();
  const deadline = Date.now() + 30_000;
  while (!peer.operations.some(row => row.operation === "stt.transcript.ready")) {
    assert.ok(Date.now() < deadline, "Host speech must reach the local Parakeet model");
    await delay(100);
  }
  await delay(500); // Allow the newly captioned frame to arrive at the remote decoder.
  const captionPixels = await peer.captionPixels();
  const [stats] = await peer.publisher.stats();
  await peer.flush();

  assert.ok(captionPixels > baseline + 500, "The remote video must contain caption text, not only listening status");
  assert.ok(stats.audioBytesReceived > 0 && stats.hostAudioFrames > 0);
  assert.equal(transcripts[0].participantId, "remote");
  assert.match(transcripts[0].text, /I don't wish to see it any more/i);
  assert.equal(peer.operations.some(row => row.error), false);
});

test("guest audio is not submitted to Parakeet even when received over WebRTC", {
  skip: !modelDirectory && "Set PARAKEET_MODEL_DIR to run real-model verification",
  timeout: 30_000,
}, async t => {
  const transcripts = [];
  const peer = await mediaPeer(t, { transcription: { modelDirectory, onTranscript: result => transcripts.push(result) } });
  peer.session.snapshot.pts = [{ cid: "remote", r: "Guest" }];
  await peer.prepareAudio(Float32Array.from({ length: 16_000 }, (_, i) => Math.sin(i * 0.1) * 0.2), 16_000);
  await peer.publisher.start();
  await peer.received();

  await peer.playAudio();
  await delay(2_000); // One second of sound plus the 600 ms endpoint interval.
  const [stats] = await peer.publisher.stats();

  assert.ok(stats.audioBytesReceived > 0, "Guest audio must arrive before checking that transcription is excluded");
  assert.equal(stats.hostAudioFrames, 0);
  assert.deepEqual(transcripts, []);
  assert.equal(peer.operations.some(row => row.operation === "stt.utterance.started"), false);
  assert.equal(peer.operations.some(row => row.error), false);
});
