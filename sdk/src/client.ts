import { parseGuestUrl, type GuestSessionAddress } from "./guest-url.js";
import { object, participant, roomSnapshot, type JsonObject, type RoomSnapshot, type SessionEvent } from "./protocol.js";
import type { SyntheticMediaOptions, SyntheticMediaPublisher } from "./synthetic-media.js";

export interface ClientOptions {
  name?: string;
  deviceId?: string;
  /** Defaults use same-origin API routes, not the legacy Collider endpoint. */
  roomsUrl?: string;
  webSocketUrl?: string;
  timeoutMs?: number;
  heartbeatMs?: number;
  /** A fresh invitation exchange otherwise creates a new anonymous participant/device. */
  logger?: (entry: { level: "info" | "error"; operation: string }) => void;
}

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class LiveSessionClient {
  readonly address: GuestSessionAddress;
  #options: ClientOptions;
  #socket?: WebSocket;
  #snapshot?: RoomSnapshot;
  #deviceId?: string;
  #accessToken?: string;
  #media?: SyntheticMediaPublisher;
  #startingMedia = false;
  #listeners = new Set<(event: SessionEvent) => void>();
  #pending = new Map<string, PendingRequest>();
  #mid = 0;
  #heartbeat?: ReturnType<typeof setInterval>;
  #latency = 0;
  #pingInFlight = false;
  #started = false;
  #closed = false;
  #abort = new AbortController();

  constructor(guestUrl: string, options: ClientOptions = {}) {
    this.address = parseGuestUrl(guestUrl);
    this.#options = options;
    for (const value of [options.timeoutMs ?? 15_000, options.heartbeatMs ?? 10_000]) {
      if (!Number.isFinite(value) || value <= 0) throw new Error("Timeouts must be positive numbers");
    }
  }

  get snapshot(): RoomSnapshot | undefined { return this.#snapshot; }
  get deviceId(): string | undefined { return this.#deviceId; }

  onEvent(listener: (event: SessionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  /** Joins Setup; knock() requests entry to Live. A client instance is single-use. */
  async connect(): Promise<RoomSnapshot> {
    if (this.#started) throw new Error("Client already started; create a new client to connect again");
    this.#started = true;
    try {
      const roomsUrl = this.#options.roomsUrl ?? `${this.address.baseUrl}/api/rooms/v2/join-room`;
      const httpUrl = new URL(roomsUrl);
      if (!["http:", "https:"].includes(httpUrl.protocol) || httpUrl.username || httpUrl.password) {
        throw new Error("Rooms endpoint must use HTTP(S) without user credentials");
      }
      const url = new URL(this.#options.webSocketUrl ?? `${this.address.baseUrl}/api/live/ws`);
      if (!this.#options.webSocketUrl) url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password) {
        throw new Error("WebSocket endpoint must use WS(S) without user credentials");
      }
      this.#log("guest.exchange.started");
      const joined = await this.#exchange(httpUrl.toString());
      this.#deviceId = joined.deviceId;
      this.#accessToken = joined.accessToken;
      this.#log("guest.exchange.completed");
      if (this.#closed) throw new Error("Client is closed");
      this.#log("websocket.connecting");
      await this.#open(url.toString());
      this.#snapshot = roomSnapshot(await this.#request("join", {
        room: this.address.roomId, creds: joined.credentials, name: this.#options.name ?? "AI agent",
      }));
      this.#log("room.joined");
      this.#emit({ type: "joined", data: this.#snapshot });
      this.#startHeartbeat();
      return this.#snapshot;
    } catch (error) {
      this.#log("connection.failed", "error");
      this.#shutdown();
      throw error;
    }
  }

  async knock(): Promise<RoomSnapshot> {
    this.#requireJoined();
    // Live replies to knock with cmd=join; correlation is by rid, not command name.
    this.#snapshot = roomSnapshot(await this.#request("knock", {}));
    this.#log("room.knocked");
    this.#emit({ type: "joined", data: this.#snapshot });
    return this.#snapshot;
  }

  /** Sends a participant event. The server does not acknowledge pub commands. */
  publish(type: string, data: unknown, recipientId?: string): void {
    this.#requireJoined();
    if (this.#snapshot?.area !== "Live") throw new Error("Participant must be in Live to publish");
    this.#send("pub", { type, data, ...(recipientId ? { cid: recipientId } : {}) });
    this.#log("participant.event.sent");
  }

  /** Can be prepared in Setup before knock, or started after entering Live. */
  async startSyntheticMedia(options: SyntheticMediaOptions = {}): Promise<void> {
    this.#requireJoined();
    if (this.#media || this.#startingMedia) throw new Error("Synthetic media is already started");
    this.#startingMedia = true;
    try {
      const { SyntheticMediaPublisher } = await import("./synthetic-media.js");
      const iceServers = options.iceServers ?? await this.#loadIceServers(
        options.iceUrl ?? `${this.address.baseUrl}/api/legacy-rooms/ice`,
      );
      this.#requireJoined();
      this.#media = new SyntheticMediaPublisher(this, iceServers,
        (operation, error) => this.#log(operation, error ? "error" : "info"), options);
      await this.#media.start();
      this.#requireJoined();
    } catch {
      await this.#media?.stop().catch(() => this.#log("media.stop.failed", "error"));
      this.#media = undefined;
      this.#log("media.start.failed", "error");
      throw new Error(options.transcription
        ? "Unable to start captioned media; check local Parakeet files, sherpa-onnx-node, Chromium and the ICE endpoint"
        : "Unable to start synthetic media; install Playwright Chromium and check the ICE endpoint");
    } finally {
      this.#startingMedia = false;
    }
  }

  async stopSyntheticMedia(): Promise<void> {
    if (!this.#media) return;
    if (!this.#closed && this.#snapshot?.area === "Live") {
      this.publish("device.devices.state", {
        audioinput: { current: null, pending: null, paused: true, echoCancellation: false, noiseSuppression: false },
        videoinput: { current: null, pending: null, paused: true },
        audiooutput: { current: null, pending: null, paused: true },
      });
    }
    const media = this.#media;
    this.#media = undefined;
    await media.stop();
  }

  disconnect(): void {
    if (this.#closed) return;
    if (this.#snapshot && this.#socket?.readyState === WebSocket.OPEN) {
      this.#send("leave", { close: false });
      this.#log("room.left");
    }
    this.#shutdown();
  }

  async #exchange(endpoint: string): Promise<{ credentials: string; deviceId?: string; accessToken?: string }> {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST", redirect: "error",
        headers: { "Content-Type": "application/json", "User-Agent": "shutter-live-session-sdk/0.1" },
        signal: AbortSignal.any([this.#abort.signal, AbortSignal.timeout(this.#options.timeoutMs ?? 15_000)]),
        body: JSON.stringify({
          roomId: this.address.roomId, joinToken: this.address.guestToken,
          deviceId: this.#options.deviceId,
          device: {
            id: this.#options.deviceId,
            platform: { implementation: "live-session-sdk", platform: "Node.js" },
            screenSize: { w: 0, h: 0 },
            cameras: { defaultCamera: "", cameras: [] },
          },
        }),
      });
    } catch {
      throw new Error("Rooms invitation exchange failed (network, redirect, cancellation, or timeout)");
    }
    if (!response.ok) throw new Error(`Rooms invitation exchange rejected (HTTP ${response.status})`);
    let data: unknown;
    try { data = await response.json(); } catch { throw new Error("Rooms returned invalid JSON"); }
    if (!object(data) || !object(data.ws) || typeof data.ws.token !== "string" || !data.ws.token ||
        (data.deviceId != null && typeof data.deviceId !== "string")) {
      throw new Error("Rooms returned invalid participant credentials");
    }
    // ws.url may advertise a legacy signaling server; Photo Session App also uses a configured Live URL.
    return {
      credentials: data.ws.token, deviceId: data.deviceId as string | undefined,
      accessToken: object(data.session) && typeof data.session.token === "string" ? data.session.token : undefined,
    };
  }

  async #loadIceServers(endpoint: string): Promise<RTCIceServer[]> {
    const url = new URL(endpoint);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new Error("Invalid ICE endpoint");
    }
    this.#log("media.ice.fetch.started");
    const response = await fetch(url, {
      method: "POST", redirect: "error",
      headers: {
        "Content-Type": "application/json",
        ...(this.#accessToken ? { Authorization: `Bearer ${this.#accessToken}` } : {}),
      },
      body: "{}",
      signal: AbortSignal.any([this.#abort.signal, AbortSignal.timeout(this.#options.timeoutMs ?? 15_000)]),
    });
    if (!response.ok) throw new Error("ICE endpoint rejected request");
    const data: unknown = await response.json();
    if (!object(data) || !Array.isArray(data.iceServers) ||
        !data.iceServers.every(server => object(server) &&
          (typeof server.urls === "string" || Array.isArray(server.urls) && server.urls.every(url => typeof url === "string")))) {
      throw new Error("ICE endpoint returned invalid servers");
    }
    this.#log("media.ice.fetch.completed");
    return data.iceServers as RTCIceServer[];
  }

  #open(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      this.#socket = socket;
      const timer = setTimeout(() => {
        reject(new Error("WebSocket connection timed out"));
        this.#shutdown();
      }, this.#options.timeoutMs ?? 15_000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("message", (event) => this.#receive(event.data));
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("WebSocket connection failed"));
        this.#log("websocket.failed", "error");
        this.#shutdown();
      });
      socket.addEventListener("close", (event) => {
        clearTimeout(timer);
        reject(new Error("WebSocket closed before connecting"));
        this.#shutdown();
        this.#emit({ type: "disconnected", data: { code: event.code } });
      });
    });
  }

  #send(cmd: string, args: JsonObject): string {
    if (this.#socket?.readyState !== WebSocket.OPEN) throw new Error("WebSocket is not connected");
    const mid = String(++this.#mid);
    this.#socket.send(JSON.stringify({ ...args, cmd, mid }));
    return mid;
  }

  #request(cmd: string, args: JsonObject): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const mid = String(this.#mid + 1);
      const timer = setTimeout(() => {
        this.#pending.delete(mid);
        reject(new Error(`Live ${cmd} response timed out`));
      }, this.#options.timeoutMs ?? 15_000);
      this.#pending.set(mid, { resolve, reject, timer });
      try { this.#send(cmd, args); } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(mid);
        reject(error);
      }
    });
  }

  #receive(raw: unknown): void {
    let message: unknown;
    try { message = JSON.parse(String(raw)); } catch {
      this.#log("protocol.invalid-json", "error");
      this.#shutdown();
      return;
    }
    if (!object(message)) {
      this.#log("protocol.invalid-message", "error");
      this.#shutdown();
      return;
    }
    if (message.type === "resp") {
      const request = this.#pending.get(String(message.rid));
      if (request) {
        clearTimeout(request.timer);
        this.#pending.delete(String(message.rid));
        if (message.error != null) request.reject(new Error("Live command was rejected by the server"));
        else request.resolve(message.data);
      }
      return;
    }
    const payload = object(message.event) ? message.event : message;
    if (typeof payload.type !== "string") return;
    const event: SessionEvent = { type: payload.type, data: payload.data,
      ...(typeof message.p === "string" ? { participantId: message.p } : {}) };
    this.#updateSnapshot(event);
    if (event.type === "room.closed" || event.type === "duplicate-session") this.#shutdown();
    this.#emit(event);
  }

  #updateSnapshot(event: SessionEvent): void {
    const snapshot = this.#snapshot;
    if (!snapshot) return;
    if (event.type === "room.joined" && participant(event.data)) {
      const joined = event.data;
      snapshot.pts = [...(snapshot.pts ?? []).filter(p => p.cid !== joined.cid), joined];
    } else if (event.type === "room.left" && object(event.data)) {
      const cid = event.data.cid;
      snapshot.pts = snapshot.pts?.filter(p => p.cid !== cid);
    } else if (event.type === "room.session.updated" && object(event.data)) {
      snapshot.session = event.data;
    } else if (event.type === "recording.started" && object(event.data)) {
      snapshot.recording = event.data;
    } else if (event.type === "recording.stopped") {
      delete snapshot.recording;
    }
  }

  #startHeartbeat(): void {
    if (this.#closed) return;
    this.#heartbeat = setInterval(() => {
      if (this.#pingInFlight) return;
      this.#pingInFlight = true;
      const sentAt = Date.now();
      void this.#request("ping", { ts: sentAt, latency: this.#latency })
        .then(() => { this.#latency = Math.round((Date.now() - sentAt) / 2); })
        .catch(() => { this.#log("heartbeat.failed", "error"); this.#shutdown(); })
        .finally(() => { this.#pingInFlight = false; });
    }, this.#options.heartbeatMs ?? 10_000);
  }

  #requireJoined(): void {
    if (!this.#snapshot || this.#closed) throw new Error("Client is not joined");
  }

  #shutdown(): void {
    if (this.#closed) return;
    this.#closed = true;
    void this.#media?.stop().catch(() => this.#log("media.stop.failed", "error"));
    this.#media = undefined;
    this.#accessToken = undefined;
    this.#abort.abort();
    clearInterval(this.#heartbeat);
    for (const request of this.#pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Live connection closed"));
    }
    this.#pending.clear();
    this.#socket?.close();
    this.#log("connection.closed");
  }

  #emit(event: SessionEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  #log(operation: string, level: "info" | "error" = "info"): void {
    this.#options.logger?.({ level, operation });
  }
}
