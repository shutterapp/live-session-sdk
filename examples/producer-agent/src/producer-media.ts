import { readFile } from "node:fs/promises";
import type { LiveSessionClient, Participant } from "@shutter-studio/live-session-sdk";
import { fileURLToPath } from "node:url";
import { CaptionChannel } from "@shutter-studio/caption-media/caption-channel";
import { ensureParakeetModel } from "@shutter-studio/caption-media/parakeet-model";
import { ParakeetTranscriber } from "@shutter-studio/caption-media/parakeet";

const modelDirectory = fileURLToPath(new URL("../../../models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8", import.meta.url));

export class ProducerMedia {
  guest?: Participant;
  unsubscribe?: () => void;
  transcriber: ParakeetTranscriber;
  channel: CaptionChannel;
  generation = 0;

  constructor(private readonly client: LiveSessionClient, onTranscript: (text: string) => void) {
    this.transcriber = new ParakeetTranscriber({ modelDirectory }, ({ participantId, text }) => {
      if (participantId !== this.guest?.cid) return;
      onTranscript(text);
      this.channel.update({ speaker: this.guest.p.name ?? "Guest", caption: text });
    }, (operation, error) => {
      console.error(operation);
      if (error) this.channel.update({ transcriptionAvailable: false });
    });
    this.channel = new CaptionChannel((generation, samples) => {
      if (this.guest && generation === this.generation) {
        this.transcriber.accept({ participantId: this.guest.cid, sampleRate: 16_000, samples });
      }
    }, event => {
      if (this.guest && event.participantId === this.guest.cid) this.transcriber.reset();
    }, operation => console.error(operation));
  }

  async start(signal: AbortSignal) {
    this.unsubscribe = this.client.onEvent(({ type }) => {
      if (["joined", "room.joined", "room.left"].includes(type)) this.selectGuest();
    });
    this.selectGuest();
    await ensureParakeetModel(modelDirectory, { signal });
    signal.throwIfAborted();
    await this.transcriber.start();
    signal.throwIfAborted();
    const config = await this.channel.start();
    const script = await readFile(new URL("./browser.js", import.meta.url), "utf8");
    await this.client.startMedia({
      sourceScript: `window.studioCaptionChannel = ${JSON.stringify(config)};\n${script}`,
      recordingDirectory: fileURLToPath(new URL("../recordings/", import.meta.url)),
      browserPermissions: ["local-network-access"],
      videoEncoding: { maxFramerate: 15, maxBitrate: 3_000_000, degradationPreference: "maintain-resolution" },
    });
    this.announceDevices();
  }

  selectGuest() {
    const guest = this.client.snapshot?.pts?.find(p => p.r === "Guest" && !p.l);
    if (guest?.cid === this.guest?.cid) return;
    this.guest = guest;
    this.transcriber.reset();
    this.channel.update({ hostId: guest?.cid ?? null, generation: ++this.generation });
  }

  announceDevices() {
    this.client.publishDeviceList({
      videoinput: [{ id: "producer-camera", label: "Producer captions" }],
      audioinput: [{ id: "silent-mic", label: "Silent microphone" }],
      audiooutput: [],
    });
    this.client.publishDeviceState({
      videoinput: { current: "producer-camera", pending: null, paused: false },
      audioinput: { current: "silent-mic", pending: null, paused: false, echoCancellation: false, noiseSuppression: false },
      audiooutput: { current: null, pending: null, paused: true },
    });
  }

  async stop() {
    this.unsubscribe?.();
    await Promise.all([this.client.stopMedia(), this.channel.stop(), this.transcriber.stop()]);
  }
}
