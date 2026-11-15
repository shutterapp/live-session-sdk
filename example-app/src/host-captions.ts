import type { JsonObject, LiveSessionClient } from "@shutter-studio/live-session-sdk";
import { ParakeetTranscriber, type ParakeetOptions, type Transcript } from "./parakeet.js";
import { CaptionChannel, type CaptionChannelConfig } from "./caption-channel.js";

export class HostCaptions {
  #client: LiveSessionClient;
  #transcriber: ParakeetTranscriber;
  #channel: CaptionChannel;
  #hostId?: string;
  #generation = 0;
  #stopped = false;
  #log: (operation: string, error?: boolean) => void;

  constructor(client: LiveSessionClient, options: ParakeetOptions,
      onTranscript: (result: Transcript) => void,
      log: (operation: string, error?: boolean) => void) {
    this.#client = client;
    this.#log = log;
    this.#channel = new CaptionChannel((generation, samples) => {
      if (this.#stopped || !this.#hostId || generation !== this.#generation) return;
      this.#transcriber.accept({ participantId: this.#hostId, sampleRate: 16_000, samples });
    }, event => this.#onMediaEvent(event), log);
    this.#transcriber = new ParakeetTranscriber(options, result => {
      if (this.#stopped || result.participantId !== this.#hostId) return;
      this.#update({ caption: result.text });
      onTranscript(result);
    }, (operation, error) => {
      this.#log(operation, error);
      if (error) this.#update({ transcriptionAvailable: false, listening: false, caption: "" });
    });
  }

  async start(): Promise<CaptionChannelConfig> {
    const config = await this.#channel.start();
    await this.#transcriber.start();
    return config;
  }

  syncParticipants(): void {
    const room = this.#client.snapshot;
    const id = room?.pts?.find(p => p.r === "Host" && p.cid !== room.self.cid && !p.l)?.cid;
    if (id === this.#hostId) return;
    this.#hostId = id;
    this.#generation++;
    this.#transcriber.reset();
    this.#update({
      hostId: id ?? null, generation: this.#generation,
      hostPresent: Boolean(id), caption: "", listening: false, level: 0,
    });
    this.#log(id ? "stt.host.selected" : "stt.host.cleared");
  }

  #onMediaEvent(event: JsonObject): void {
    if (this.#stopped || event.participantId !== this.#hostId) return;
    if (event.type === "audio.dropped") {
      this.#transcriber.reset();
      this.#log("stt.audio.dropped");
    } else if (event.type === "audio.stopped") {
      this.#transcriber.reset();
    } else if (event.type === "audio.failed") {
      this.#log("stt.audio.failed", true);
      this.#update({ transcriptionAvailable: false, listening: false });
    }
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    await Promise.all([this.#transcriber.stop(), this.#channel.stop()]);
  }

  #update(state: JsonObject): void {
    if (this.#stopped) return;
    this.#channel.update(state);
  }
}
