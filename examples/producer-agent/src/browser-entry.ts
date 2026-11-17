import type { BrowserMediaSource, JsonObject } from "@shutter-studio/live-session-sdk";
import { installMatrixVideo, type VideoState } from "./matrix-video.js";
import type { CaptionChannelConfig } from "./caption-channel.js";

declare global {
  interface Window { studioCaptionChannel: CaptionChannelConfig }
}

async function createProducerAgentMedia(): Promise<BrowserMediaSource> {
  installMatrixVideo({ captioning: true });
  const video = window.studioVideo;
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
  let generation = 0;
  let waitingForAck = false;
  let dropping = false;
  let socket: WebSocket;
  let capture: { id: string; source: MediaStreamAudioSourceNode; worklet: AudioWorkletNode; player: HTMLAudioElement } | undefined;
  const emit = (event: JsonObject) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
  };
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
    emit({ type: "audio.stopped", participantId: previous.id });
  };
  const failCapture = (id: string) => {
    stopCapture();
    available = false;
    video.update({ transcriptionAvailable: false, listening: false });
    emit({ type: "audio.failed", participantId: id });
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
      if (waitingForAck || socket.bufferedAmount > 65_536) {
        if (!dropping) emit({ type: "audio.dropped", participantId: id });
        dropping = true;
        return;
      }
      // Keep Float32 PCM throughout. The header identifies the selected host generation.
      const packet = new Uint8Array(4 + samples.byteLength);
      new DataView(packet.buffer).setUint32(0, generation, true);
      packet.set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength), 4);
      try {
        socket.send(packet);
        waitingForAck = true;
        dropping = false;
      } catch { failCapture(id); }
    };
    worklet.onprocessorerror = () => failCapture(id);
    source.connect(worklet).connect(captureAudio.destination);
    // WebRTC playout drives extraction; Chromium uses fake output streams, not hardware.
    void player.play().catch(() => { if (!stopped && capture?.id === id) failCapture(id); });
  };

  const source: BrowserMediaSource = {
    stream,
    update(change) {
      if ("hostId" in change) {
        const nextId = typeof change.hostId === "string" ? change.hostId : undefined;
        if (nextId !== hostId) {
          stopCapture();
          hostId = nextId;
          generation = Number(change.generation);
          waitingForAck = false;
          dropping = false;
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
      socket.close();
      remotes.clear();
      video.stop();
      silence.stop();
      for (const track of stream.getTracks()) track.stop();
      await Promise.all([audio.close(), captureAudio.close()]);
    },
  };

  socket = new WebSocket(window.studioCaptionChannel.url);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Caption channel connection timed out"));
    }, 10_000);
    socket.onopen = () => socket.send(JSON.stringify({
      type: "auth", token: window.studioCaptionChannel.token,
    }));
    socket.onmessage = event => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === "ack" && message.generation === generation) waitingForAck = false;
        if (message.type === "state") {
          source.update!(message.state);
          clearTimeout(timeout);
          resolve();
        }
      } catch {
        socket.close();
        reject(new Error("Invalid caption channel message"));
      }
    };
    socket.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("Caption channel connection failed"));
    };
    socket.onclose = () => {
      clearTimeout(timeout);
      reject(new Error("Caption channel closed"));
      if (!stopped) {
        available = false;
        stopCapture();
        video.update({ transcriptionAvailable: false, listening: false });
      }
    };
  });
  return source;
}

window.studioMediaSource = createProducerAgentMedia();
