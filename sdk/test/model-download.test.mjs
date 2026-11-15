import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureModelFiles } from "../dist/model-download.js";
import { downloadServer } from "./download-fixture.mjs";

test("missing model files are downloaded, verified and published without partial files", async t => {
  const server = await downloadServer(t);
  const progress = [];

  await ensureModelFiles(server.directory, [server.file], { onProgress: entry => progress.push(entry) });

  assert.equal(await readFile(join(server.directory, "model.onnx"), "utf8"), "abc");
  assert.deepEqual(await readdir(server.directory), ["model.onnx"]);
  assert.deepEqual(progress.at(-1), { file: "model.onnx", received: 3, total: 3 });
});

test("existing local model files are reused without any network request", async t => {
  const server = await downloadServer(t);
  await writeFile(join(server.directory, "model.onnx"), "local-custom-model");

  await ensureModelFiles(server.directory, [server.file]);

  assert.equal(server.requests(), 0);
  assert.equal(await readFile(join(server.directory, "model.onnx"), "utf8"), "local-custom-model");
});

test("a partially installed model downloads only missing files and preserves completed files", async t => {
  const server = await downloadServer(t);
  await writeFile(join(server.directory, "model.onnx"), "completed-local-model");

  await ensureModelFiles(server.directory, [server.file, { ...server.file, name: "second.onnx" }]);

  assert.equal(server.requests(), 1);
  assert.equal(await readFile(join(server.directory, "model.onnx"), "utf8"), "completed-local-model");
  assert.equal(await readFile(join(server.directory, "second.onnx"), "utf8"), "abc");
});

test("a checksum mismatch cannot publish a model or leave a partial file", async t => {
  const server = await downloadServer(t, { bytes: "abd" });

  await assert.rejects(ensureModelFiles(server.directory, [server.file]), /SHA-256/);

  assert.deepEqual(await readdir(server.directory), []);
});

test("a truncated download cannot be mistaken for an installed model", async t => {
  const server = await downloadServer(t, { bytes: "ab" });

  await assert.rejects(ensureModelFiles(server.directory, [server.file]), /size verification/);

  assert.deepEqual(await readdir(server.directory), []);
});

test("an oversized response stops without publishing or retaining temporary bytes", async t => {
  const server = await downloadServer(t, { bytes: "abcd" });

  await assert.rejects(ensureModelFiles(server.directory, [server.file]), /exceeded expected size/);

  assert.deepEqual(await readdir(server.directory), []);
});

test("a rejected download leaves unrelated local files untouched", async t => {
  const server = await downloadServer(t, { status: 503 });
  await writeFile(join(server.directory, "notes.txt"), "keep me");

  await assert.rejects(ensureModelFiles(server.directory, [server.file]), /rejected/);

  assert.deepEqual(await readdir(server.directory), ["notes.txt"]);
  assert.equal(await readFile(join(server.directory, "notes.txt"), "utf8"), "keep me");
});

test("cancellation aborts an in-progress download and removes its temporary file", async t => {
  const server = await downloadServer(t, { pause: true });
  const abort = new AbortController();

  const downloading = ensureModelFiles(server.directory, [server.file], { signal: abort.signal });
  const rejected = assert.rejects(downloading, { name: "AbortError" });
  await server.firstByte;
  abort.abort();
  await rejected;

  assert.deepEqual(await readdir(server.directory), []);
});
