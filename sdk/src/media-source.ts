import type { JsonObject } from "./protocol.js";

/** Implemented by caller-supplied browser code, never by the SDK. */
export interface BrowserMediaSource {
  stream: MediaStream;
  update?(state: JsonObject): void | Promise<void>;
  onRemoteTrack?(participantId: string, track: MediaStreamTrack): void;
  onPeerState?(participantId: string, state: RTCPeerConnectionState): void;
  stop(): void | Promise<void>;
}

export interface VideoEncodingOptions {
  maxBitrate?: number;
  maxFramerate?: number;
  scaleResolutionDownBy?: number;
  degradationPreference?: RTCDegradationPreference;
}

declare global {
  interface Window {
    shutterMediaSource: BrowserMediaSource | Promise<BrowserMediaSource>;
    shutterMediaEmit(event: JsonObject): Promise<void>;
  }
}
