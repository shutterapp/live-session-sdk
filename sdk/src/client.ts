import { createRequire } from "node:module";
import type { AlwaysConnected as ConnectionManager, ConnectionStateChangeEvent } from "@deilux/websocket-js";
import { parseGuestUrl, type GuestSessionAddress } from "./guest-url.js";
import { object, participant, roomSnapshot, type EventHandler, type JsonObject, type RoomSnapshot, type SessionEvent } from "./protocol.js";
import type { MediaOptions, MediaPublisher } from "./media.js";

// Version 0.2.0's ESM entry has extensionless imports that Node cannot resolve.
const { AlwaysConnected, ConnectionState } = createRequire(import.meta.url)("@deilux/websocket-js") as typeof import("@deilux/websocket-js");

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
  cmd: string;
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class LiveSessionClient {
  readonly address: GuestSessionAddress;
  #options: ClientOptions;
  #connection?: ConnectionManager;
  #snapshot?: RoomSnapshot;
  #deviceId?: string;
  #accessToken?: string;
  #media?: MediaPublisher;
  #startingMedia = false;
  #listeners = new Set<EventHandler>();
  #stoppingMedia?: Promise<void>;
  #pending = new Map<string, PendingRequest>();
  #mid = 0;
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

  onEvent(listener: EventHandler): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  on<T extends string>(type: T, listener: EventHandler<T>): () => void {
    return this.onEvent(event => {
      if (event.type === type) return listener(event as SessionEvent<T>);
    });
  }

  /** For commands with a correlated server response. */
  async command(cmd: string, args: JsonObject = {}): Promise<unknown> {
    this.#requireJoined();
    this.#validateCommand(cmd, args);
    this.#log("room.command.started");
    try {
      const result = await this.#request(cmd, args);
      this.#log("room.command.completed");
      return result;
    } catch (error) {
      this.#log("room.command.failed", "error");
      throw error;
    }
  }

  /** For commands whose outcome is delivered as events, not RPC replies. */
  sendCommand(cmd: string, args: JsonObject = {}): void {
    this.#requireJoined();
    this.#validateCommand(cmd, args);
    this.#send(cmd, args);
    this.#log("room.command.sent");
  }

  /** Confirmation arrives through recording events; permissions are server-owned. */
  startRecording(options: { onBehalfOf?: string[] } = {}): void {
    this.sendCommand("record-start", options.onBehalfOf ? { "on-behalf-of": options.onBehalfOf } : {});
  }

  stopRecording(id?: string): void {
    this.sendCommand("record-stop", id ? { id } : {});
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
      await this.#open(url.toString(), joined.credentials);
      return this.#snapshot!;
    } catch (error) {
      this.#log("connection.failed", "error");
      this.#shutdown();
      throw error;
    }
  }

  async knock(): Promise<RoomSnapshot> {
    this.#requireJoined();
    // Live replies to knock with cmd=join; correlation is by rid, not command name.
    await this.#request("knock", {});
    this.#log("room.knocked");
    return this.#snapshot!;
  }

  /** Sends a participant event. The server does not acknowledge pub commands. */
  publish(type: string, data: unknown, recipientId?: string): void {
    this.#requireJoined();
    if (this.#snapshot?.area !== "Live") throw new Error("Participant must be in Live to publish");
    this.#send("pub", { type, data, ...(recipientId ? { cid: recipientId } : {}) });
    this.#log("participant.event.sent");
  }

  /** Can be prepared in Setup before knock, or started after entering Live. */
  async startMedia(options: MediaOptions): Promise<void> {
    this.#requireJoined();
    if (this.#media || this.#startingMedia) throw new Error("Media is already started");
    if (!options.sourceScript.trim()) throw new Error("A browser media source script is required");
    this.#startingMedia = true;
    try {
      const { MediaPublisher } = await import("./media.js");
      const iceServers = options.iceServers ?? await this.#loadIceServers(
        options.iceUrl ?? `${this.address.baseUrl}/api/legacy-rooms/ice`,
      );
      this.#requireJoined();
      this.#media = new MediaPublisher(this, iceServers,
        (operation, error) => this.#log(operation, error ? "error" : "info"), options);
      await this.#media.start();
      this.#requireJoined();
    } catch {
      await this.#media?.stop().catch(() => this.#log("media.stop.failed", "error"));
      this.#media = undefined;
      this.#log("media.start.failed", "error");
      throw new Error("Unable to start media; check the source script, Playwright Chromium and the ICE endpoint");
    } finally {
      this.#startingMedia = false;
    }
  }

  async stopMedia(): Promise<void> {
    if (!this.#media) { await this.#stoppingMedia; return; }
    const media = this.#media;
    this.#media = undefined;
    this.#stoppingMedia = media.stop();
    await this.#stoppingMedia;
  }

  async updateMedia(state: JsonObject): Promise<void> {
    this.#requireJoined();
    if (!this.#media) throw new Error("Media is not started");
    await this.#media.update(state);
  }

  disconnect(): void {
    if (this.#closed) return;
    try {
      if (this.#snapshot && this.#connection?.state === ConnectionState.Connected) {
        this.#send("leave", { close: false });
        this.#log("room.left");
      }
    } finally {
      this.#shutdown();
    }
  }

  /** Disconnects and waits for media resources to finish closing. */
  async close(): Promise<void> {
    this.disconnect();
    await this.#stoppingMedia;
  }

  async #exchange(endpoint: string): Promise<{ credentials: string; deviceId?: string; accessToken?: string }> {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST", redirect: "error",
        headers: { "Content-Type": "application/json", "User-Agent": "studio-live-session-sdk/0.1" },
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

  #open(url: string, credentials: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("WebSocket connection timed out"));
        this.#shutdown();
      }, this.#options.timeoutMs ?? 15_000);
      const connection = new AlwaysConnected(() => {
        const socket = new WebSocket(url);
        const opening = setTimeout(() => connection.handleWebSocketError(socket), this.#options.timeoutMs ?? 15_000);
        socket.addEventListener("open", () => {
          clearTimeout(opening);
          clearTimeout(timer);
          connection.handleWebSocketOpen();
        });
        socket.addEventListener("message", event => this.#receive(event.data));
        socket.addEventListener("error", () => connection.handleWebSocketError(socket));
        socket.addEventListener("close", () => {
          clearTimeout(opening);
          connection.handleWebSocketClosed(socket);
        });
        return socket;
      }, async () => {
        const socket = connection.websocket;
        try {
          await (this.#snapshot
            ? this.#request("resume", { sid: this.#snapshot.sid })
            : this.#request("join", {
              room: this.address.roomId, creds: credentials, name: this.#options.name ?? "AI agent",
            }));
          return true;
        } catch (error) {
          if (connection.websocket !== socket || connection.state === ConnectionState.Reconnecting) return false;
          clearTimeout(timer);
          reject(error);
          this.#shutdown();
          return false;
        }
      }, () => this.#heartbeat(), {
        heartbeatInterval: this.#options.heartbeatMs ?? 10_000,
        reconnectDelay: 2_000,
        connectionTimeout: this.#options.timeoutMs ?? 15_000,
      });
      this.#connection = connection;
      connection.addEventListener("connectiontimeout", () => {
        if (this.#snapshot) return;
        reject(new Error("Live join response timed out"));
        this.#shutdown();
      });
      connection.addEventListener("statechange", event => {
        const { state } = event as ConnectionStateChangeEvent;
        if (state === ConnectionState.Reconnecting) {
          this.#rejectPending();
          this.#log("websocket.reconnecting");
          this.#emit({ type: "reconnecting", data: {} });
        } else if (state === ConnectionState.Connected) {
          clearTimeout(timer);
          this.#log("room.joined");
          this.#emit({ type: "joined", data: this.#snapshot });
          resolve();
        }
      });
      this.#abort.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("Live connection closed"));
      }, { once: true });
      connection.activate();
    });
  }

  #send(cmd: string, args: JsonObject): string {
    const socket = this.#connection?.websocket as WebSocket | null | undefined;
    if (socket?.readyState !== WebSocket.OPEN) throw new Error("WebSocket is not connected");
    const mid = String(++this.#mid);
    socket.send(JSON.stringify({ ...args, cmd, mid }));
    return mid;
  }

  #request(cmd: string, args: JsonObject): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const mid = String(this.#mid + 1);
      const timer = setTimeout(() => {
        this.#pending.delete(mid);
        reject(new Error(`Live ${cmd} response timed out`));
      }, this.#options.timeoutMs ?? 15_000);
      this.#pending.set(mid, { cmd, resolve, reject, timer });
      try { this.#send(cmd, args); } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(mid);
        reject(error);
      }
    });
  }

  #receive(raw: unknown): void {
    if (this.#closed) return;
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
        else if (["join", "resume", "knock"].includes(request.cmd)) {
          try {
            this.#snapshot = roomSnapshot(message.data);
            request.resolve(this.#snapshot);
            if (request.cmd === "knock") this.#emit({ type: "joined", data: this.#snapshot });
          } catch { request.reject(new Error("Live API returned an invalid room snapshot")); }
        } else request.resolve(message.data);
      } else if (message.cmd === "join" || message.cmd === "resume") {
        try {
          this.#snapshot = roomSnapshot(message.data);
          this.#log("room.joined");
          this.#emit({ type: "joined", data: this.#snapshot });
        } catch {
          this.#log("protocol.invalid-admission", "error");
          this.#shutdown();
        }
      }
      return;
    }
    const payload = object(message.event) ? message.event : message;
    if (typeof payload.type !== "string") return;
    const event: SessionEvent = { type: payload.type, data: payload.data,
      ...(typeof message.p === "string" ? { participantId: message.p } : {}) };
    this.#updateSnapshot(event);
    this.#emit(event);
    if (event.type === "room.closed" || event.type === "duplicate-session") this.#shutdown();
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

  #heartbeat(): void {
    if (this.#closed || this.#pingInFlight) return;
    this.#pingInFlight = true;
    const socket = this.#connection?.websocket;
    const sentAt = Date.now();
    void this.#request("ping", { ts: sentAt, latency: this.#latency })
      .then(() => { this.#latency = Math.round((Date.now() - sentAt) / 2); })
      .catch(() => {
        if (this.#closed || this.#connection?.websocket !== socket ||
            this.#connection?.state !== ConnectionState.Connected) return;
        this.#log("heartbeat.failed", "error");
        this.#connection.handleWebSocketHeartbeatTimeout();
      })
      .finally(() => { this.#pingInFlight = false; });
  }

  #requireJoined(): void {
    if (!this.#snapshot || this.#closed || this.#connection?.state !== ConnectionState.Connected) {
      throw new Error("Client is not joined");
    }
  }

  #validateCommand(cmd: string, args: JsonObject): void {
    if (!cmd.trim() || ["join", "resume", "knock", "leave", "pub", "ping"].includes(cmd.toLowerCase())) {
      throw new Error("Use the dedicated lifecycle or publish method for this command");
    }
    if ("cmd" in args || "mid" in args) throw new Error("Command arguments cannot override protocol fields");
  }

  #shutdown(): void {
    if (this.#closed) return;
    this.#closed = true;
    void this.stopMedia().catch(() => this.#log("media.stop.failed", "error"));
    this.#accessToken = undefined;
    this.#abort.abort();
    this.#rejectPending();
    this.#connection?.shutdown();
    this.#log("connection.closed");
    this.#emit({ type: "disconnected", data: {} });
  }

  #rejectPending(): void {
    for (const request of this.#pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Live connection closed"));
    }
    this.#pending.clear();
  }

  #emit(event: SessionEvent): void {
    for (const listener of this.#listeners) {
      try {
        void Promise.resolve(listener(event)).catch(() => this.#log("event.handler.failed", "error"));
      } catch {
        this.#log("event.handler.failed", "error");
      }
    }
  }

  #log(operation: string, level: "info" | "error" = "info"): void {
    this.#options.logger?.({ level, operation });
  }
}
