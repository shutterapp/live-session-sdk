import test from "node:test";
import assert from "node:assert/strict";
import { SpeechSegmenter } from "../dist/speech-segmenter.js";

test("silence and a brief impulse do not produce speech utterances", () => {
  const utterances = [];
  const segmenter = new SpeechSegmenter(samples => utterances.push(samples));

  segmenter.accept(new Float32Array(1600));
  segmenter.accept(new Float32Array(1600).fill(0.1));
  for (let i = 0; i < 6; i++) segmenter.accept(new Float32Array(1600));

  assert.equal(utterances.length, 0);
});

test("speech ending in silence emits one mono utterance with pre-roll", () => {
  const utterances = [];
  const segmenter = new SpeechSegmenter(samples => utterances.push(samples));
  segmenter.accept(new Float32Array(1600));

  for (let i = 0; i < 4; i++) segmenter.accept(new Float32Array(1600).fill(0.1));
  for (let i = 0; i < 6; i++) segmenter.accept(new Float32Array(1600));

  assert.equal(utterances.length, 1);
  assert.equal(utterances[0].length, 17_600);
  assert.ok(utterances[0].subarray(0, 1600).every(value => value === 0));
});

test("continuous speech is split at eight seconds rather than buffered indefinitely", () => {
  const utterances = [];
  const segmenter = new SpeechSegmenter(samples => utterances.push(samples));

  for (let i = 0; i < 160; i++) segmenter.accept(new Float32Array(1600).fill(0.1));

  assert.deepEqual(utterances.map(samples => samples.length), [128_000, 128_000]);
});

test("reset discards speech buffered for a previous participant", () => {
  const utterances = [];
  const segmenter = new SpeechSegmenter(samples => utterances.push(samples));
  for (let i = 0; i < 3; i++) segmenter.accept(new Float32Array(1600).fill(0.1));

  segmenter.reset();
  for (let i = 0; i < 6; i++) segmenter.accept(new Float32Array(1600));

  assert.equal(utterances.length, 0);
});
