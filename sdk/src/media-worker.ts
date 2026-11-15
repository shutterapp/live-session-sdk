import type { JsonObject } from "./protocol.js";
import type { VideoEncodingOptions } from "./media-source.js";

export type MediaCommand =
  | { kind: "enter"; selfId: string; participants: string[] }
  | { kind: "event"; type: string; participantId?: string; data?: JsonObject }
  | { kind: "leave"; participantId: string }
  | { kind: "source.update"; state: JsonObject };

export interface MediaWorkerOptions {
  iceServers: RTCIceServer[];
  initialState?: JsonObject;
  videoEncoding?: VideoEncodingOptions;
}

export interface MediaStats {
  participantId: string;
  state: RTCPeerConnectionState;
  audioBytesSent: number;
  videoBytesSent: number;
  videoFramesEncoded: number;
  audioBytesReceived: number;
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
  }
}

/** Serialized into Chromium. The caller owns tracks and their application behavior. */
export async function installMediaWorker({ iceServers, initialState, videoEncoding }: MediaWorkerOptions): Promise<void> {
  const source = await window.shutterMediaSource;
  const stream = source.stream;
  if (!(stream instanceof MediaStream) || !stream.getTracks().length ||
      stream.getAudioTracks().length > 1 || stream.getVideoTracks().length > 1) {
    throw new Error("Media source must provide up to one audio and one video track");
  }
  if (initialState) await source.update?.(initialState);

  interface Peer {
    pc: RTCPeerConnection;
    participantId: string;
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
  const notifyState = (peer: Peer, state: RTCPeerConnectionState) => {
    try { source.onPeerState?.(peer.participantId, state); }
    catch { log("media.source.state.failed", true); }
  };
  const closePeer = (peer: Peer) => {
    peer.pc.onicecandidate = null;
    peer.pc.onconnectionstatechange = null;
    peer.pc.ontrack = null;
    peer.pc.close();
    notifyState(peer, "closed");
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
    if (!videoEncoding) return;
    for (const sender of peer.pc.getSenders()) {
      if (sender.track?.kind !== "video") continue;
      const parameters = sender.getParameters();
      if (videoEncoding.degradationPreference) parameters.degradationPreference = videoEncoding.degradationPreference;
      for (const encoding of parameters.encodings) {
        if (videoEncoding.scaleResolutionDownBy !== undefined) encoding.scaleResolutionDownBy = videoEncoding.scaleResolutionDownBy;
        if (videoEncoding.maxBitrate !== undefined) encoding.maxBitrate = videoEncoding.maxBitrate;
        if (videoEncoding.maxFramerate !== undefined) encoding.maxFramerate = videoEncoding.maxFramerate;
      }
      await sender.setParameters(parameters);
    }
  };
  const createPeer = (id: string, connectionId: string, offer: boolean): Peer => {
    const pc = new RTCPeerConnection({ iceServers });
    const peer: Peer = {
      pc, participantId: id, connectionId, remoteCandidates: earlyCandidates.get(id) ?? [],
      localCandidates: [], localSent: false, ignoringOffer: false,
    };
    earlyCandidates.delete(id);
    peers.set(id, peer);
    pc.ontrack = event => {
      try { source.onRemoteTrack?.(id, event.track); }
      catch { log("media.source.track.failed", true); }
    };
    if (offer) {
      for (const kind of ["audio", "video"]) {
        const track = stream.getTracks().find(track => track.kind === kind);
        pc.addTransceiver(track ?? kind, {
          direction: track ? "sendrecv" : "recvonly", streams: track ? [stream] : [],
          sendEncodings: track?.kind === "video" && videoEncoding ? [{
            scaleResolutionDownBy: videoEncoding.scaleResolutionDownBy,
            maxBitrate: videoEncoding.maxBitrate, maxFramerate: videoEncoding.maxFramerate,
          }] : undefined,
        });
      }
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
      notifyState(peer, pc.connectionState);
      if (pc.connectionState === "failed") { closePeer(peer); peers.delete(id); }
    };
    return peer;
  };

  window.shutterMedia = {
    async handle(command) {
      if (stopped) return;
      if (command.kind === "source.update") { await source.update?.(command.state); return; }
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
        if (peer && peer.connectionId !== data.connectionId) { closePeer(peer); peers.delete(id); peer = undefined; }
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
          const track = stream.getTracks().find(track => track.kind === kind);
          transceiver.direction = track ? "sendrecv" : "recvonly";
          if (track) { await transceiver.sender.replaceTrack(track); transceiver.sender.setStreams(stream); }
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
        const row: MediaStats = {
          participantId, state: peer.pc.connectionState,
          audioBytesSent: 0, videoBytesSent: 0, videoFramesEncoded: 0, audioBytesReceived: 0, audioSourceEnergy: 0,
        };
        (await peer.pc.getStats()).forEach(stat => {
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
      for (const peer of peers.values()) closePeer(peer);
      peers.clear();
      earlyCandidates.clear();
      try { await source.stop(); }
      finally { for (const track of stream.getTracks()) track.stop(); }
    },
  };
}
