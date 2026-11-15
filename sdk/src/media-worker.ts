import type { JsonObject } from "./protocol.js";

export type MediaCommand =
  | { kind: "enter"; selfId: string; participants: string[] }
  | { kind: "event"; type: string; participantId?: string; data?: JsonObject }
  | { kind: "leave"; participantId: string }
  | { kind: "host"; participantId?: string }
  | { kind: "caption"; text: string }
  | { kind: "transcription-unavailable" };

export interface MediaWorkerOptions { iceServers: RTCIceServer[]; captureHostAudio: boolean }

export interface MediaStats {
  participantId: string;
  state: RTCPeerConnectionState;
  audioBytesSent: number;
  videoBytesSent: number;
  videoFramesEncoded: number;
  audioBytesReceived: number;
  hostAudioFrames: number;
  audioSourceEnergy: number;
}

export interface BrowserMediaWorker {
  handle(command: MediaCommand): Promise<void>;
  stats(): Promise<MediaStats[]>;
  stop(): Promise<void>;
}

declare global {
  interface Window {
    shutterMedia: BrowserMediaWorker;
    shutterMediaSignal(type: string, data: JsonObject, recipientId: string): Promise<void>;
    shutterMediaLog(operation: string, error: boolean): Promise<void>;
    shutterHostAudio(participantId: string, pcm16: string): Promise<void>;
  }
}

/** Serialized by Playwright into Chromium. All runtime helpers must stay inside this function. */
export async function installMediaWorker({ iceServers, captureHostAudio }: MediaWorkerOptions): Promise<void> {
  const video = window.shutterVideo;
  const videoTrack = video.track;

  const audio = new AudioContext({ sampleRate: 48_000 });
  const silence = audio.createConstantSource();
  silence.offset.value = 0;
  const destination = audio.createMediaStreamDestination();
  silence.connect(destination);
  silence.start();
  await audio.resume();
  const audioTrack = destination.stream.getAudioTracks()[0]!;
  const stream = new MediaStream([audioTrack, videoTrack]);

  const captureAudio = captureHostAudio ? new AudioContext({ sampleRate: 16_000 }) : undefined;
  if (captureAudio) {
    const moduleUrl = URL.createObjectURL(new Blob([`
      class HostPcm extends AudioWorkletProcessor {
        constructor() {
          super();
          this.frame = new Float32Array(1600);
          this.offset = 0;
        }
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
  }

  interface Peer {
    pc: RTCPeerConnection;
    connectionId: string;
    remoteCandidates: RTCIceCandidateInit[];
    localCandidates: RTCIceCandidateInit[];
    localSent: boolean;
    ignoringOffer: boolean;
    remoteAudio?: MediaStreamTrack;
    source?: MediaStreamAudioSourceNode;
    capture?: AudioWorkletNode;
    playback?: HTMLAudioElement;
    hostAudioFrames: number;
  }
  const peers = new Map<string, Peer>();
  const earlyCandidates = new Map<string, RTCIceCandidateInit[]>();
  let selfId = "";
  let hostId: string | undefined;
  let stopped = false;
  const log = (operation: string, error = false) => { void window.shutterMediaLog(operation, error); };
  const signal = (type: string, data: JsonObject, id: string) => {
    if (!stopped) void window.shutterMediaSignal(type, data, id);
  };
  const stopCapture = (peer: Peer) => {
    peer.source?.disconnect();
    if (peer.playback) {
      peer.playback.pause();
      peer.playback.srcObject = null;
      peer.playback.remove();
      peer.playback = undefined;
    }
    if (peer.capture) {
      video.update({ listening: false, level: 0 });
      peer.capture.onprocessorerror = null;
      peer.capture.port.onmessage = null;
      peer.capture.port.close();
      peer.capture.disconnect();
    }
    peer.source = undefined;
    peer.capture = undefined;
  };
  const startCapture = (id: string, peer: Peer) => {
    if (!captureAudio || id !== hostId || !peer.remoteAudio || peer.capture ||
        peer.pc.connectionState !== "connected") return;
    peer.source = captureAudio.createMediaStreamSource(new MediaStream([peer.remoteAudio]));
    peer.capture = new AudioWorkletNode(captureAudio, "host-pcm", {
      channelCount: 1, channelCountMode: "explicit",
    });
    peer.capture.port.onmessage = event => {
      if (stopped || id !== hostId) return;
      peer.hostAudioFrames++;
      const samples = event.data as Float32Array;
      const level = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
      video.update({ listening: true, level });
      const bytes = new Uint8Array(samples.length * 2);
      const view = new DataView(bytes.buffer);
      for (let i = 0; i < samples.length; i++) {
        view.setInt16(i * 2, Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 32767), true);
      }
      void window.shutterHostAudio(id, btoa(String.fromCharCode(...bytes))).catch(() => {
        if (stopped || id !== hostId) return;
        video.update({ transcriptionAvailable: false, listening: false });
        log("stt.audio.bridge.failed", true);
        stopCapture(peer);
      });
    };
    peer.capture.onprocessorerror = () => {
      video.update({ transcriptionAvailable: false, listening: false });
      log("stt.audio.capture.failed", true);
      stopCapture(peer);
    };
    // The worklet outputs silence; incoming audio is never played on local speakers.
    peer.source.connect(peer.capture).connect(captureAudio.destination);
    // Keep Chromium's WebRTC audio playout active; the worker process is muted.
    peer.playback = document.createElement("audio");
    peer.playback.srcObject = new MediaStream([peer.remoteAudio]);
    document.body.append(peer.playback);
    void peer.playback.play().catch(() => {
      if (stopped || id !== hostId || !peer.playback) return;
      video.update({ transcriptionAvailable: false, listening: false });
      log("stt.audio.playout.failed", true);
    });
  };
  const closePeer = (peer: Peer) => {
    stopCapture(peer);
    peer.pc.onicecandidate = null;
    peer.pc.onconnectionstatechange = null;
    peer.pc.ontrack = null;
    peer.pc.close();
  };
  const candidate = (id: string, value: RTCIceCandidateInit) => signal("webrtc.p2p.ice-candidate", {
    streamId: value.sdpMid, lineIndex: value.sdpMLineIndex, candidate: value.candidate,
  }, id);
  const description = (id: string, peer: Peer, type: "offer" | "answer") => {
    signal(`webrtc.p2p.${type}`, {
      sdp: peer.pc.localDescription!.sdp,
      ...(type === "offer" ? { connectionId: peer.connectionId } : {}),
    }, id);
    peer.localSent = true;
    for (const value of peer.localCandidates.splice(0)) candidate(id, value);
    log(`media.${type}.sent`);
  };
  const drain = async (peer: Peer) => {
    for (const value of peer.remoteCandidates.splice(0)) await peer.pc.addIceCandidate(value);
  };
  const configureVideo = async (peer: Peer) => {
    for (const sender of peer.pc.getSenders()) {
      if (sender.track?.kind !== "video") continue;
      const parameters = sender.getParameters();
      parameters.degradationPreference = "maintain-resolution";
      for (const encoding of parameters.encodings) {
        encoding.scaleResolutionDownBy = 1;
        encoding.maxBitrate = 3_000_000;
        encoding.maxFramerate = 15;
      }
      await sender.setParameters(parameters);
    }
  };
  const createPeer = (id: string, connectionId: string, offer: boolean): Peer => {
    const pc = new RTCPeerConnection({ iceServers });
    const peer: Peer = {
      pc, connectionId, remoteCandidates: earlyCandidates.get(id) ?? [],
      localCandidates: [], localSent: false, ignoringOffer: false,
      hostAudioFrames: 0,
    };
    earlyCandidates.delete(id);
    peers.set(id, peer);
    pc.ontrack = event => {
      if (event.track.kind === "audio") {
        stopCapture(peer);
        peer.remoteAudio = event.track;
        event.track.addEventListener("ended", () => {
          if (peer.remoteAudio === event.track) stopCapture(peer);
        }, { once: true });
        startCapture(id, peer);
      }
    };
    if (offer) {
      pc.addTransceiver(audioTrack, { direction: "sendrecv", streams: [stream] });
      pc.addTransceiver(videoTrack, {
        direction: "sendrecv", streams: [stream],
        sendEncodings: [{ scaleResolutionDownBy: 1, maxBitrate: 3_000_000, maxFramerate: 15 }],
      });
    }
    pc.onicecandidate = event => {
      if (!event.candidate || stopped) return;
      const value = event.candidate.toJSON();
      if (peer.localSent) candidate(id, value);
      else peer.localCandidates.push(value);
    };
    pc.onconnectionstatechange = () => {
      if (stopped) return;
      log(`media.peer.${pc.connectionState}`, pc.connectionState === "failed");
      if (pc.connectionState === "connected") startCapture(id, peer);
      if (pc.connectionState === "disconnected") stopCapture(peer);
      if (pc.connectionState === "failed") {
        closePeer(peer);
        peers.delete(id);
      }
    };
    return peer;
  };

  window.shutterMedia = {
    async handle(command) {
      if (stopped) return;
      if (command.kind === "caption") {
        video.update({ caption: command.text.replace(/\s+/g, " ").trim().slice(-1_200) });
        return;
      }
      if (command.kind === "transcription-unavailable") {
        video.update({ transcriptionAvailable: false, listening: false, caption: "" });
        return;
      }
      if (command.kind === "host") {
        if (hostId === command.participantId) return;
        hostId = command.participantId;
        video.update({ hostPresent: Boolean(hostId), listening: false, caption: "", level: 0 });
        for (const [id, peer] of peers) { stopCapture(peer); startCapture(id, peer); }
        return;
      }
      if (command.kind === "leave") {
        const peer = peers.get(command.participantId);
        if (peer) closePeer(peer);
        peers.delete(command.participantId);
        earlyCandidates.delete(command.participantId);
        return;
      }
      if (command.kind === "enter") {
        selfId = command.selfId;
        for (const id of command.participants) {
          if (peers.has(id)) continue;
          const peer = createPeer(id, crypto.randomUUID(), true);
          await peer.pc.setLocalDescription(await peer.pc.createOffer());
          if (!stopped) description(id, peer, "offer");
        }
        return;
      }
      const id = command.participantId;
      const data = command.data;
      if (!id || !data) return;
      if (command.type === "webrtc.p2p.offer" && typeof data.sdp === "string" && typeof data.connectionId === "string") {
        let peer = peers.get(id);
        if (peer && peer.connectionId !== data.connectionId) {
          closePeer(peer);
          peers.delete(id);
          peer = undefined;
        }
        peer ??= createPeer(id, data.connectionId, false);
        const collision = peer.pc.signalingState === "have-local-offer";
        peer.ignoringOffer = collision && selfId >= id;
        if (peer.ignoringOffer) return;
        if (collision) await peer.pc.setLocalDescription({ type: "rollback" });
        peer.localSent = false;
        await peer.pc.setRemoteDescription({ type: "offer", sdp: data.sdp });
        await drain(peer);
        for (const transceiver of peer.pc.getTransceivers()) {
          const kind = transceiver.receiver.track.kind;
          if (kind !== "audio" && kind !== "video") continue;
          transceiver.direction = "sendrecv";
          await transceiver.sender.replaceTrack(kind === "audio" ? audioTrack : videoTrack);
          transceiver.sender.setStreams(stream);
        }
        await peer.pc.setLocalDescription(await peer.pc.createAnswer());
        await configureVideo(peer);
        if (!stopped) description(id, peer, "answer");
      } else if (command.type === "webrtc.p2p.answer" && typeof data.sdp === "string") {
        const peer = peers.get(id);
        if (!peer || peer.pc.signalingState !== "have-local-offer") return;
        await peer.pc.setRemoteDescription({ type: "answer", sdp: data.sdp });
        await configureVideo(peer);
        await drain(peer);
      } else if (command.type === "webrtc.p2p.ice-candidate" &&
          typeof data.candidate === "string" && typeof data.streamId === "string" && typeof data.lineIndex === "number") {
        const value = { candidate: data.candidate, sdpMid: data.streamId, sdpMLineIndex: data.lineIndex };
        const peer = peers.get(id);
        if (!peer) {
          const pending = earlyCandidates.get(id) ?? [];
          pending.push(value);
          earlyCandidates.set(id, pending);
        } else if (!peer.ignoringOffer) {
          if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(value);
          else peer.remoteCandidates.push(value);
        }
      }
    },
    async stats() {
      const result: MediaStats[] = [];
      for (const [participantId, peer] of peers) {
        const stats = await peer.pc.getStats();
        const row: MediaStats = {
          participantId, state: peer.pc.connectionState,
          audioBytesSent: 0, videoBytesSent: 0, videoFramesEncoded: 0,
          audioBytesReceived: 0, hostAudioFrames: peer.hostAudioFrames,
          audioSourceEnergy: 0,
        };
        stats.forEach(stat => {
          if (stat.type === "media-source" && stat.kind === "audio") row.audioSourceEnergy += stat.totalAudioEnergy ?? 0;
          if (stat.type === "inbound-rtp" && stat.kind === "audio") row.audioBytesReceived += stat.bytesReceived ?? 0;
          if (stat.type !== "outbound-rtp") return;
          if (stat.kind === "audio") row.audioBytesSent += stat.bytesSent ?? 0;
          if (stat.kind === "video") {
            row.videoBytesSent += stat.bytesSent ?? 0;
            row.videoFramesEncoded += stat.framesEncoded ?? 0;
          }
        });
        result.push(row);
      }
      return result;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      video.stop();
      silence.stop();
      for (const track of stream.getTracks()) track.stop();
      for (const peer of peers.values()) closePeer(peer);
      peers.clear();
      earlyCandidates.clear();
      await audio.close();
      await captureAudio?.close();
    },
  };
}
