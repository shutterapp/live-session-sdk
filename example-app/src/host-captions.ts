import type { JsonObject, LiveSessionClient } from "@shutter-studio/live-session-sdk";
import { ParakeetTranscriber, type ParakeetOptions, type Transcript } from "./parakeet.js";

export class HostCaptions {
  #client: LiveSessionClient;
  #transcriber: ParakeetTranscriber;
  #hostId?: string;
  #stopped = false;
  #log: (operation: string, error?: boolean) => void;

  constructor(client: LiveSessionClient, options: ParakeetOptions,
      onTranscript: (result: Transcript) => void,
      log: (operation: string, error?: boolean) => void) {
    this.#client = client;
    this.#log = log;
    this.#transcriber = new ParakeetTranscriber(options, result => {
      if (this.#stopped || result.participantId !== this.#hostId) return;
      this.#update({ caption: result.text });
      onTranscript(result);
    }, (operation, error) => {
      this.#log(operation, error);
      if (error) this.#update({ transcriptionAvailable: false, listening: false, caption: "" });
    });
  }

  start(): Promise<void> { return this.#transcriber.start(); }

  syncParticipants(): void {
    const room = this.#client.snapshot;
    const id = room?.pts?.find(p => p.r === "Host" && p.cid !== room.self.cid && !p.l)?.cid;
    if (id === this.#hostId) return;
    this.#hostId = id;
    this.#transcriber.reset();
    this.#update({ hostId: id ?? null, hostPresent: Boolean(id), caption: "", listening: false, level: 0 });
    this.#log(id ? "stt.host.selected" : "stt.host.cleared");
  }

  onMediaEvent(event: JsonObject): void {
    if (this.#stopped || event.participantId !== this.#hostId) return;
    if (event.type === "audio" && typeof event.pcm16 === "string") {
      const bytes = Buffer.from(event.pcm16, "base64");
      if (bytes.length !== 3_200) throw new Error("Invalid host audio frame");
      const samples = Float32Array.from({ length: 1_600 }, (_, index) => bytes.readInt16LE(index * 2) / 32768);
      this.#transcriber.accept({ participantId: this.#hostId!, sampleRate: 16_000, samples });
    } else if (event.type === "audio.failed") {
      this.#log("stt.audio.failed", true);
      this.#update({ transcriptionAvailable: false, listening: false });
    }
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    await this.#transcriber.stop();
  }

  #update(state: JsonObject): void {
    if (this.#stopped) return;
    void this.#client.updateMedia(state).catch(() => {
      if (!this.#stopped) this.#log("stt.video.update.failed", true);
    });
  }
}
