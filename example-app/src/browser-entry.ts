import type { BrowserMediaSource, JsonObject } from "@shutter-studio/live-session-sdk";
import { installMatrixVideo, type VideoState } from "./matrix-video.js";

async function createAgentMedia(): Promise<BrowserMediaSource> {
  installMatrixVideo({ captioning: true });
  const video = window.shutterVideo;
  const audio = new AudioContext({ sampleRate: 48_000 });
  const silence = audio.createConstantSource();
  silence.offset.value = 0;
  const destination = audio.createMediaStreamDestination();
  silence.connect(destination);
  silence.start();
  await audio.resume();
  const stream = new MediaStream([destination.stream.getAudioTracks()[0]!, video.track]);

  const captureAudio = new AudioContext({ sampleRate: 16_000 });
  const moduleUrl = URL.createObjectURL(new Blob([`
    class HostPcm extends AudioWorkletProcessor {
      constructor() { super(); this.frame = new Float32Array(1600); this.offset = 0; }
      process(inputs) {
        const samples = inputs[0]?.[0];
        if (!samples) return true;
        for (const value of samples) {
          this.frame[this.offset++] = value;
          if (this.offset === 1600) {
            this.port.postMessage(this.frame, [this.frame.buffer]);
            this.frame = new Float32Array(1600);
            this.offset = 0;
          }
        }
        return true;
      }
    }
    registerProcessor("host-pcm", HostPcm);
  `], { type: "text/javascript" }));
  try { await captureAudio.audioWorklet.addModule(moduleUrl); }
  finally { URL.revokeObjectURL(moduleUrl); }
  await captureAudio.resume();

  const remotes = new Map<string, { track?: MediaStreamTrack; state?: RTCPeerConnectionState }>();
  let hostId: string | undefined;
  let stopped = false;
  let available = true;
  let capture: { id: string; source: MediaStreamAudioSourceNode; worklet: AudioWorkletNode; player: HTMLAudioElement } | undefined;
  const emit = (event: JsonObject) => window.shutterMediaEmit(event);
  const stopCapture = () => {
    if (!capture) return;
    const previous = capture;
    capture = undefined;
    previous.worklet.onprocessorerror = null;
    previous.worklet.port.onmessage = null;
    previous.worklet.port.close();
    previous.source.disconnect();
    previous.worklet.disconnect();
    previous.player.pause();
    previous.player.srcObject = null;
    previous.player.remove();
    video.update({ listening: false, level: 0 });
    void emit({ type: "audio.stopped", participantId: previous.id }).catch(() => {});
  };
  const failCapture = (id: string) => {
    stopCapture();
    available = false;
    video.update({ transcriptionAvailable: false, listening: false });
    void emit({ type: "audio.failed", participantId: id }).catch(() => {});
  };
  const startCapture = () => {
    if (stopped || !available || !hostId || capture) return;
    const remote = remotes.get(hostId);
    if (!remote?.track || remote.state !== "connected") return;
    const id = hostId;
    const source = captureAudio.createMediaStreamSource(new MediaStream([remote.track]));
    const worklet = new AudioWorkletNode(captureAudio, "host-pcm", { channelCount: 1, channelCountMode: "explicit" });
    const player = document.createElement("audio");
    player.srcObject = new MediaStream([remote.track]);
    document.body.append(player);
    capture = { id, source, worklet, player };
    worklet.port.onmessage = event => {
      if (stopped || capture?.id !== id) return;
      const samples = event.data as Float32Array;
      video.update({
        listening: true,
        level: Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length),
      });
      const bytes = new Uint8Array(samples.length * 2);
      const view = new DataView(bytes.buffer);
      for (let i = 0; i < samples.length; i++) {
        view.setInt16(i * 2, Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 32767), true);
      }
      void emit({ type: "audio", participantId: id, pcm16: btoa(String.fromCharCode(...bytes)) }).catch(() => {
        if (!stopped && capture?.id === id) failCapture(id);
      });
    };
    worklet.onprocessorerror = () => failCapture(id);
    source.connect(worklet).connect(captureAudio.destination);
    // WebRTC playout must run for extraction; the SDK's Chromium process is muted.
    void player.play().catch(() => { if (!stopped && capture?.id === id) failCapture(id); });
  };

  return {
    stream,
    update(change) {
      if ("hostId" in change) {
        const nextId = typeof change.hostId === "string" ? change.hostId : undefined;
        if (nextId !== hostId) {
          stopCapture();
          hostId = nextId;
          video.update({ hostPresent: Boolean(hostId), caption: "", listening: false, level: 0 });
        }
      }
      if (change.transcriptionAvailable === false) { available = false; stopCapture(); }
      video.update(change as Partial<VideoState>);
      startCapture();
    },
    onRemoteTrack(id, track) {
      if (track.kind !== "audio") return;
      const remote = remotes.get(id) ?? {};
      if (remote.track !== track && capture?.id === id) stopCapture();
      remote.track = track;
      remotes.set(id, remote);
      track.addEventListener("ended", () => {
        if (remotes.get(id)?.track === track && capture?.id === id) stopCapture();
      }, { once: true });
      startCapture();
    },
    onPeerState(id, state) {
      const remote = remotes.get(id) ?? {};
      remote.state = state;
      remotes.set(id, remote);
      if (capture?.id === id && state !== "connected") stopCapture();
      if (state === "closed") remotes.delete(id);
      startCapture();
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      stopCapture();
      remotes.clear();
      video.stop();
      silence.stop();
      for (const track of stream.getTracks()) track.stop();
      await Promise.all([audio.close(), captureAudio.close()]);
    },
  };
}

window.shutterMediaSource = createAgentMedia();
