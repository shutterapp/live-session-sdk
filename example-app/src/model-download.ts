import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, stat, link, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";

export interface ModelFile { name: string; url: string; size: number; sha256: string }
export interface ModelDownloadOptions {
  signal?: AbortSignal;
  onProgress?: (progress: { file: string; received: number; total: number }) => void;
}

/** Existing local files are preserved; new files are published only after verification. */
export async function ensureModelFiles(directory: string, files: readonly ModelFile[],
    options: ModelDownloadOptions = {}): Promise<void> {
  const signal = AbortSignal.any([
    ...(options.signal ? [options.signal] : []), AbortSignal.timeout(30 * 60_000),
  ]);
  await mkdir(directory, { recursive: true });
  for (const file of files) {
    signal.throwIfAborted();
    const target = join(directory, file.name);
    let existing;
    try { existing = await stat(target); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (existing) {
      if (!existing.isFile() || !existing.size) throw new Error("Local model path is empty or not a regular file");
      continue;
    }

    const temporary = join(directory, `.${file.name}.${randomUUID()}.download`);
    try {
      options.onProgress?.({ file: file.name, received: 0, total: file.size });
      const response = await fetch(file.url, { signal });
      if (!response.ok || !response.body) throw new Error("Model download was rejected");
      const hash = createHash("sha256");
      let received = 0;
      let lastProgress = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          received += chunk.length;
          if (received > file.size) { done(new Error("Model download exceeded expected size")); return; }
          hash.update(chunk);
          const progress = Math.floor(received / file.size * 10);
          if (progress > lastProgress) {
            lastProgress = progress;
            options.onProgress?.({ file: file.name, received, total: file.size });
          }
          done(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(response.body as ReadableStream),
        meter, createWriteStream(temporary, { flags: "wx" }), { signal },
      );
      if (received !== file.size || hash.digest("hex") !== file.sha256) {
        throw new Error("Model download failed SHA-256 or size verification");
      }
      signal.throwIfAborted();
      // A same-directory hard link publishes atomically without overwriting an existing file.
      await link(temporary, target);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
}
