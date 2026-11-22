import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { defineAgent, type JsonObject, type Room } from "@shutter-studio/live-session-sdk";
import { ParakeetTranscriber, type ParakeetOptions } from "@shutter-studio/caption-media/parakeet";
import { CaptionChannel } from "@shutter-studio/caption-media/caption-channel";

export function createAssistantAgent(options: ParakeetOptions,
    log: (operation: string, error?: boolean) => void) {
  return defineAgent({
    entry: async ctx => {
      const assistant = new AssistantAgent(ctx.room, options, log);
      ctx.onShutdown(() => assistant.stop());
      await assistant.start(ctx.signal);
    },
  });
}

export class AssistantAgent {
  #room: Room;
  #unsubscribe?: () => void;
  #mediaReady = false;
  #transcriber: ParakeetTranscriber;
  #channel: CaptionChannel;
  #hostId?: string;
  #generation = 0;
  #stopped = false;
  #log: (operation: string, error?: boolean) => void;

  constructor(room: Room, options: ParakeetOptions,
      log: (operation: string, error?: boolean) => void) {
    this.#room = room;
    this.#log = log;
    this.#channel = new CaptionChannel((generation, samples) => {
      if (this.#stopped || !this.#hostId || generation !== this.#generation) return;
      this.#transcriber.accept({ participantId: this.#hostId, sampleRate: 16_000, samples });
    }, event => this.#onMediaEvent(event), log);
    this.#transcriber = new ParakeetTranscriber(options, result => {
      if (this.#stopped || result.participantId !== this.#hostId) return;
      this.#update({ caption: result.text });
      console.log(JSON.stringify({ event: "transcript", participantId: result.participantId, text: result.text }));
    }, (operation, error) => {
      this.#log(operation, error);
      if (error) this.#update({ transcriptionAvailable: false, listening: false, caption: "" });
    });
  }

  async start(signal?: AbortSignal): Promise<void> {
    this.#unsubscribe = this.#room.onEvent(event => {
      console.log(JSON.stringify({ event: event.type, participantId: event.participantId }));
      if (["joined", "room.joined", "room.left"].includes(event.type)) this.syncParticipants();
      if (event.type === "joined" && this.#mediaReady) this.#announceDevices();
    });
    this.syncParticipants();
    const sourceScript = await readFile(new URL("./browser.js", import.meta.url), "utf8");
    signal?.throwIfAborted();
    const config = await this.#channel.start();
    await this.#transcriber.start();
    signal?.throwIfAborted();
    if (this.#stopped) return;
    await this.#room.startMedia({
      sourceScript: `window.studioCaptionChannel = ${JSON.stringify(config)};\n${sourceScript}`,
      recordingDirectory: fileURLToPath(new URL("../recordings/", import.meta.url)),
      browserPermissions: ["local-network-access"],
      videoEncoding: {
        maxBitrate: 3_000_000, maxFramerate: 15, scaleResolutionDownBy: 1, degradationPreference: "maintain-resolution",
      },
    });
    signal?.throwIfAborted();
    this.#mediaReady = true;
    this.syncParticipants();
    this.#announceDevices();
    const room = this.#room.snapshot!;
    console.log(JSON.stringify({
      status: "connected",
      participantId: room.self.cid, role: room.self.r, area: room.area,
    }));
  }

  syncParticipants(): void {
    const room = this.#room.snapshot;
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
    this.#unsubscribe?.();
    await Promise.all([this.#room.stopMedia(), this.#transcriber.stop(), this.#channel.stop()]);
  }

  #announceDevices(): void {
    if (this.#room.snapshot?.area !== "Live") return;
    this.#room.publishDeviceList({
      videoinput: [{ id: "matrix-camera", label: "Matrix captions" }],
      audioinput: [{ id: "silent-mic", label: "Silent microphone" }],
      audiooutput: [],
    });
    this.#room.publishDeviceState({
      audioinput: { current: "silent-mic", pending: null, paused: false, echoCancellation: false, noiseSuppression: false },
      videoinput: { current: "matrix-camera", pending: null, paused: false },
      audiooutput: { current: null, pending: null, paused: true },
    });
  }

  #update(state: JsonObject): void {
    if (this.#stopped) return;
    this.#channel.update(state);
  }
}
