import type { JsonObject } from "./protocol.js";

export type MediaCommand =
  | { kind: "enter"; selfId: string; participants: string[] }
  | { kind: "event"; type: string; participantId?: string; data?: JsonObject }
  | { kind: "leave"; participantId: string };

export interface MediaStats {
  participantId: string;
  state: RTCPeerConnectionState;
  audioBytesSent: number;
  videoBytesSent: number;
  videoFramesEncoded: number;
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
  }
}

/** Serialized by Playwright into Chromium. All runtime helpers must stay inside this function. */
export async function installMediaWorker(iceServers: RTCIceServer[]): Promise<void> {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 360;
  document.body.append(canvas);
  const context = canvas.getContext("2d")!;
  let frame = 0;
  const draw = () => {
    const colors = ["#ffffff", "#ffff00", "#00ffff", "#00ff00", "#ff00ff", "#ff0000", "#0000ff", "#101010"];
    for (let i = 0; i < colors.length; i++) {
      context.fillStyle = colors[i]!;
      context.fillRect(i * 80, 0, 80, 360);
    }
    context.fillStyle = "#ffffff";
    context.fillRect((frame * 8) % 640, 0, 24, 360);
    context.fillStyle = "#101010";
    context.fillRect(0, 290, 640, 70);
    context.fillStyle = "#ffffff";
    context.font = "24px monospace";
    context.fillText("AI AGENT / TEST VIDEO", 16, 318);
    context.fillText(`frame ${frame++}`, 16, 346);
  };
  draw();
  const videoTimer = setInterval(draw, 1000 / 15);
  const videoTrack = canvas.captureStream(15).getVideoTracks()[0]!;

  const audio = new AudioContext({ sampleRate: 48_000 });
  // Continuous rendering stays inside Chromium, not a Node timer feeding raw samples.
  const buffer = audio.createBuffer(1, audio.sampleRate * 10, audio.sampleRate);
  const samples = buffer.getChannelData(0);
  for (let i = 0; i < samples.length; i++) samples[i] = (Math.random() * 2 - 1) * 0.03;
  const noise = audio.createBufferSource();
  noise.buffer = buffer;
  noise.loop = true;
  const destination = audio.createMediaStreamDestination();
  noise.connect(destination); // No local speaker output.
  noise.start();
  await audio.resume();
  const audioTrack = destination.stream.getAudioTracks()[0]!;
  const stream = new MediaStream([audioTrack, videoTrack]);

  interface Peer {
    pc: RTCPeerConnection;
    connectionId: string;
    remoteCandidates: RTCIceCandidateInit[];
    localCandidates: RTCIceCandidateInit[];
    localSent: boolean;
    ignoringOffer: boolean;
  }
  const peers = new Map<string, Peer>();
  const earlyCandidates = new Map<string, RTCIceCandidateInit[]>();
  let selfId = "";
  let stopped = false;
  const log = (operation: string, error = false) => { void window.shutterMediaLog(operation, error); };
  const signal = (type: string, data: JsonObject, id: string) => {
    if (!stopped) void window.shutterMediaSignal(type, data, id);
  };
  const closePeer = (peer: Peer) => {
    peer.pc.onicecandidate = null;
    peer.pc.onconnectionstatechange = null;
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
  const createPeer = (id: string, connectionId: string, offer: boolean): Peer => {
    const pc = new RTCPeerConnection({ iceServers });
    const peer: Peer = {
      pc, connectionId, remoteCandidates: earlyCandidates.get(id) ?? [],
      localCandidates: [], localSent: false, ignoringOffer: false,
    };
    earlyCandidates.delete(id);
    peers.set(id, peer);
    if (offer) {
      pc.addTransceiver(audioTrack, { direction: "sendrecv", streams: [stream] });
      pc.addTransceiver(videoTrack, { direction: "sendrecv", streams: [stream] });
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
        if (!stopped) description(id, peer, "answer");
      } else if (command.type === "webrtc.p2p.answer" && typeof data.sdp === "string") {
        const peer = peers.get(id);
        if (!peer || peer.pc.signalingState !== "have-local-offer") return;
        await peer.pc.setRemoteDescription({ type: "answer", sdp: data.sdp });
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
        };
        stats.forEach(stat => {
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
      clearInterval(videoTimer);
      noise.stop();
      for (const track of stream.getTracks()) track.stop();
      for (const peer of peers.values()) closePeer(peer);
      peers.clear();
      earlyCandidates.clear();
      await audio.close();
      canvas.remove();
    },
  };
}
