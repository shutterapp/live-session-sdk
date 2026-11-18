import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "playwright";
import { object } from "./protocol.js";

/** One WebM on disk. Upload jobs retain file offsets, not queued media bytes. */
class TrackFile {
  private offset = 0;
  private parts = 0;
  private uploaded = Promise.resolve();

  static async create(directory: string, baseUrl: string, uploadUid: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(uploadUid)) throw new Error("Invalid track upload UID");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = await open(join(directory, `${uploadUid}.webm`), "wx+", 0o600);
    return new TrackFile(file, `${baseUrl}/api/media/v2/uploads/${uploadUid}`);
  }

  private constructor(private file: Awaited<ReturnType<typeof open>>, private url: string) {}

  async append(bytes: Buffer) {
    await this.file.writeFile(bytes);
    const offset = this.offset, size = bytes.length, part = ++this.parts;
    this.offset += size;
    this.uploaded = this.uploaded.then(async () => {
      const data = Buffer.alloc(size);
      let read = 0;
      while (read < size) {
        const { bytesRead } = await this.file.read(data, read, size - read, offset + read);
        if (!bytesRead) throw new Error("Incomplete local recording");
        read += bytesRead;
      }
      await upload(`${this.url}/${part}_unknown.part`, "PUT", data);
    });
    // Observed again by finish(), even when upload failed before capture ended.
    void this.uploaded.catch(() => {});
  }

  async finish(complete: boolean) {
    try {
      await this.uploaded;
      if (!complete || !this.parts) throw new Error("Incomplete recording; local file retained");
      await upload(`${this.url}/finalize`, "PATCH");
    } finally { await this.file.close(); }
  }
}

async function upload(url: string, method: string, bytes?: Uint8Array<ArrayBuffer>) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, {
      method, body: bytes, redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: bytes ? { "Content-Type": "application/octet-stream" } : undefined,
    }).catch(() => undefined);
    await response?.body?.cancel();
    if (response?.ok) return;
    if (attempt === 3 || (response && response.status < 500 && ![408, 429].includes(response.status))) {
      throw new Error(`Recording upload failed (${response?.status ?? "network"}); local WebM retained`);
    }
    await delay(1000 * 2 ** attempt);
  }
}

declare global {
  interface Window {
    studioRecordingChunk(base64: string): Promise<void>;
    studioStopRecording?: () => Promise<void>;
  }
}

/** Runs in Chromium against the exact stream used for outgoing WebRTC. */
async function startCapture() {
  const { stream } = await window.studioMediaSource;
  if (!stream.getAudioTracks().length || !stream.getVideoTracks().length) throw new Error("Recording needs audio and video");
  const recorder = new MediaRecorder(stream, { mimeType: "video/webm", videoBitsPerSecond: 4_500_000 });
  let written = Promise.resolve();
  let failure: unknown;
  recorder.ondataavailable = ({ data }) => {
    if (!data.size) return;
    written = written.then(async () => {
      const reader = new FileReader();
      const encoded = new Promise<string>((resolve, reject) => {
        reader.onload = () => {
          const url = String(reader.result);
          resolve(url.slice(url.lastIndexOf(",") + 1));
        };
        reader.onerror = () => reject(reader.error);
      });
      reader.readAsDataURL(data);
      await window.studioRecordingChunk(await encoded);
    }).catch(error => { failure = error; });
  };
  recorder.onerror = () => { failure = new Error("MediaRecorder failed"); };
  const stopped = new Promise<void>(resolve => { recorder.onstop = () => resolve(); });
  const started = new Promise<number>((resolve, reject) => {
    recorder.onstart = () => resolve(Date.now());
    recorder.addEventListener("error", () => reject(new Error("Unable to record outgoing media")), { once: true });
  });
  recorder.start(1000);
  window.studioStopRecording = async () => {
    if (recorder.state !== "inactive") recorder.stop();
    await stopped;
    await written;
    if (failure) throw failure;
  };
  return started;
}

export class TrackRecording {
  private active?: { id: string; file: TrackFile };
  private uploads = new Set<Promise<void>>();
  private failure?: unknown;

  constructor(private page: Page, private directory: string, private baseUrl: string) {}

  install() {
    return this.page.exposeFunction("studioRecordingChunk", async (encoded: string) => {
      if (!this.active) throw new Error("No recording assigned");
      await this.active.file.append(Buffer.from(encoded, "base64"));
    });
  }

  async start(data: unknown, self: string) {
    if (!object(data) || typeof data.id !== "string" || !object(data.tracks)) throw new Error("Invalid recording assignment");
    const track = data.tracks[self];
    if (!object(track) || typeof track.uploadUid !== "string") throw new Error("Missing local recording track");
    if (this.active?.id === data.id) return;
    await this.stop();
    this.active = { id: data.id, file: await TrackFile.create(this.directory, this.baseUrl, track.uploadUid) };
    return this.page.evaluate(startCapture);
  }

  async stop() {
    if (!this.active) return;
    const { file } = this.active;
    let complete = false;
    try {
      await this.page.evaluate(async () => {
        if (!window.studioStopRecording) throw new Error("Recording did not start");
        await window.studioStopRecording();
        delete window.studioStopRecording;
      });
      complete = true;
    } finally {
      this.active = undefined;
      const job = file.finish(complete).catch(error => { this.failure ??= error; });
      this.uploads.add(job);
      void job.then(() => this.uploads.delete(job));
    }
  }

  async close() {
    try { await this.stop(); }
    finally { await Promise.all(this.uploads); }
    if (this.failure) throw this.failure;
  }
}
