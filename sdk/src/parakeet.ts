import { Worker } from "node:worker_threads";
import { stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { SpeechSegmenter } from "./speech-segmenter.js";

export interface ParakeetOptions {
  /** Local English Parakeet TDT v2 INT8 ONNX directory. Nothing is downloaded at runtime. */
  modelDirectory: string;
  numThreads?: number;
}

export interface HostAudioFrame {
  participantId: string;
  sampleRate: 16000;
  samples: Float32Array;
}

export interface Transcript { participantId: string; text: string }

/** CPU inference is isolated from signaling and rendering. Audio is never written to disk. */
export class ParakeetTranscriber {
  #options: ParakeetOptions;
  #worker?: Worker;
  #ready = false;
  #stopped = false;
  #started = false;
  #participantId?: string;
  #generation = 0;
  #id = 0;
  #active?: { id: number; generation: number; participantId: string };
  #pending?: Float32Array;
  #segmenter: SpeechSegmenter;
  #onTranscript: (result: Transcript) => void;
  #log: (operation: string, error?: boolean) => void;
  #shutdown?: Promise<void>;

  constructor(options: ParakeetOptions, onTranscript: (result: Transcript) => void,
      log: (operation: string, error?: boolean) => void = () => {}) {
    this.#options = options;
    this.#onTranscript = onTranscript;
    this.#log = log;
    this.#segmenter = new SpeechSegmenter(samples => this.#submit(samples));
    const threads = options.numThreads ?? 2;
    if (!Number.isInteger(threads) || threads < 1 || threads > 16) throw new Error("STT threads must be between 1 and 16");
  }

  async start(): Promise<void> {
    if (this.#started || this.#stopped) throw new Error("Transcriber already started or stopped");
    this.#started = true;
    this.#log("stt.model.loading");
    try {
      const modelDirectory = resolve(this.#options.modelDirectory);
      for (const name of ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"]) {
        const file = await stat(join(modelDirectory, name));
        if (!file.isFile() || !file.size) throw new Error("Invalid model file");
      }
      if (this.#stopped) throw new Error("Transcriber stopped");
      const worker = new Worker(new URL("./parakeet-worker.js", import.meta.url), {
        workerData: { modelDirectory, numThreads: this.#options.numThreads ?? 2 },
        stdout: true, stderr: true,
      });
      this.#worker = worker;
      worker.stdout.resume();
      worker.stderr.resume();
      await new Promise<void>((resolveReady, reject) => {
        const timer = setTimeout(() => reject(new Error("STT model startup timed out")), 120_000);
        const fail = () => {
          this.#ready = false;
          clearTimeout(timer);
          reject(new Error("Local Parakeet worker failed"));
          if (!this.#stopped) {
            this.#log("stt.worker.failed", true);
            void this.stop();
          }
        };
        worker.on("error", fail);
        worker.on("exit", () => {
          clearTimeout(timer);
          reject(new Error("Local Parakeet worker exited"));
          if (!this.#stopped) fail();
        });
        worker.on("message", message => {
          if (message.type === "error") { fail(); return; }
          if (message.type === "ready") {
            clearTimeout(timer);
            this.#ready = true;
            resolveReady();
          } else if (message.type === "result" && this.#active && this.#active.id === message.id) {
            const active = this.#active;
            this.#active = undefined;
            if (!this.#stopped && active.generation === this.#generation && message.text) {
              this.#log("stt.transcript.ready");
              this.#onTranscript({ participantId: active.participantId, text: message.text });
            }
            const pending = this.#pending;
            this.#pending = undefined;
            if (pending && !this.#stopped) this.#submit(pending);
          }
        });
      });
      if (this.#stopped) throw new Error("Transcriber stopped");
      this.#log("stt.model.ready");
    } catch {
      await this.stop();
      throw new Error("Unable to load local Parakeet; check model files and optional sherpa-onnx-node installation");
    }
  }

  accept(frame: HostAudioFrame): void {
    if (!this.#ready || this.#stopped) return;
    if (frame.sampleRate !== 16_000 || frame.samples.length !== 1_600 ||
        !frame.samples.every(value => Number.isFinite(value) && Math.abs(value) <= 1)) {
      throw new Error("STT expects 100 ms frames of mono 16 kHz normalized PCM");
    }
    if (this.#participantId !== frame.participantId) {
      this.reset();
      this.#participantId = frame.participantId;
    }
    this.#segmenter.accept(frame.samples);
  }

  /** Discards unfinished audio and prevents stale inference results from being displayed. */
  reset(): void {
    this.#generation++;
    this.#segmenter.reset();
    this.#pending = undefined;
    this.#participantId = undefined;
  }

  stop(): Promise<void> {
    if (this.#shutdown) return this.#shutdown;
    this.#stopped = true;
    this.#ready = false;
    this.reset();
    this.#shutdown = (async () => {
      await this.#worker?.terminate();
      this.#log("stt.stopped");
    })();
    return this.#shutdown;
  }

  #submit(samples: Float32Array): void {
    if (!this.#ready || this.#stopped || !this.#participantId) return;
    if (this.#active) {
      if (this.#pending) this.#log("stt.audio.dropped");
      this.#pending = samples;
      return;
    }
    this.#active = { id: ++this.#id, generation: this.#generation, participantId: this.#participantId };
    this.#log("stt.utterance.started");
    this.#worker!.postMessage({ id: this.#id, samples }, [samples.buffer as ArrayBuffer]);
  }
}
