import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import type { JsonObject } from "@shutter-studio/live-session-sdk";

export interface CaptionChannelConfig { url: string; token: string }

/** Example-local transport: JSON control messages and 100 ms Float32 PCM frames. */
export class CaptionChannel {
  #server?: WebSocketServer;
  #socket?: WebSocket;
  #state: JsonObject = {};
  #stopped = false;
  #shutdown?: Promise<void>;
  #onAudio: (generation: number, samples: Float32Array) => void;
  #onEvent: (event: JsonObject) => void;
  #log: (operation: string, error?: boolean) => void;

  constructor(onAudio: (generation: number, samples: Float32Array) => void,
      onEvent: (event: JsonObject) => void,
      log: (operation: string, error?: boolean) => void) {
    this.#onAudio = onAudio;
    this.#onEvent = onEvent;
    this.#log = log;
  }

  async start(): Promise<CaptionChannelConfig> {
    if (this.#server || this.#stopped) throw new Error("Caption channel already started or stopped");
    const token = randomBytes(32).toString("hex");
    const server = new WebSocketServer({
      host: "127.0.0.1", port: 0, maxPayload: 8_192, perMessageDeflate: false,
      verifyClient: ({ origin }: { origin: string }) => origin === "https://studio-media.invalid",
    });
    this.#server = server;
    server.on("connection", socket => {
      const authTimeout = setTimeout(() => socket.terminate(), 5_000);
      let authenticated = false;
      socket.on("error", () => this.#log("caption.channel.failed", true));
      socket.on("close", () => {
        clearTimeout(authTimeout);
        if (this.#socket !== socket) return;
        this.#socket = undefined;
        if (!this.#stopped) this.#log("caption.channel.disconnected", true);
      });
      socket.on("message", (raw, binary) => {
        try {
          const bytes = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
          if (!authenticated) {
            if (binary || this.#socket) { socket.close(1008); return; }
            const auth = JSON.parse(bytes.toString());
            if (auth.type !== "auth" || auth.token !== token) { socket.close(1008); return; }
            authenticated = true;
            clearTimeout(authTimeout);
            this.#socket = socket;
            socket.send(JSON.stringify({ type: "state", state: this.#state }));
            this.#log("caption.channel.connected");
            return;
          }
          if (binary) {
            // A host generation prevents queued audio being attributed to a replacement host.
            if (bytes.length !== 6_404) throw new Error("Invalid audio frame");
            const generation = bytes.readUInt32LE(0);
            const samples = new Float32Array(1_600);
            new Uint8Array(samples.buffer).set(bytes.subarray(4));
            this.#onAudio(generation, samples);
            socket.send(JSON.stringify({ type: "ack", generation }));
          } else {
            const event: unknown = JSON.parse(bytes.toString());
            if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("Invalid channel event");
            this.#onEvent(event as JsonObject);
          }
        } catch {
          this.#log("caption.channel.invalid-message", true);
          socket.close(1008);
        }
      });
    });
    await once(server, "listening");
    server.on("error", () => this.#log("caption.channel.failed", true));
    if (this.#stopped) throw new Error("Caption channel stopped");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Caption channel did not bind");
    this.#log("caption.channel.started");
    return { url: `ws://127.0.0.1:${address.port}`, token };
  }

  update(state: JsonObject): void {
    if (this.#stopped) return;
    this.#state = { ...this.#state, ...state };
    if (this.#socket?.readyState === WebSocket.OPEN) {
      this.#socket.send(JSON.stringify({ type: "state", state }));
    }
  }

  stop(): Promise<void> {
    if (this.#shutdown) return this.#shutdown;
    this.#stopped = true;
    this.#shutdown = new Promise<void>(resolve => {
      if (!this.#server) { resolve(); return; }
      for (const socket of this.#server.clients) socket.terminate();
      this.#server.close(() => {
        this.#log("caption.channel.stopped");
        resolve();
      });
    });
    return this.#shutdown;
  }
}
