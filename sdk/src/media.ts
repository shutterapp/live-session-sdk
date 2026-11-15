import { chromium, type Browser, type Page } from "playwright";
import { object, type JsonObject, type RoomSnapshot, type SessionEvent } from "./protocol.js";
import { installMediaWorker, type MediaCommand, type MediaStats } from "./media-worker.js";
import type { VideoEncodingOptions } from "./media-source.js";

export interface MediaOptions {
  /** Trusted browser bundle defining window.studioMediaSource. */
  sourceScript: string;
  initialState?: JsonObject;
  /** Opaque events emitted by the caller's browser source. */
  onEvent?: (event: JsonObject) => void;
  videoEncoding?: VideoEncodingOptions;
  /** Overrides ICE discovery, useful for custom TURN configurations or local peers. */
  iceServers?: RTCIceServer[];
  /** Full ICE HTTP endpoint; defaults to <base>/api/legacy-rooms/ice. */
  iceUrl?: string;
}

interface MediaSession {
  readonly snapshot: RoomSnapshot | undefined;
  onEvent(listener: (event: SessionEvent) => void): () => void;
  publish(type: string, data: unknown, recipientId?: string): void;
}

/** Node owns Live signaling; Chromium owns generated tracks and modern browser P2P WebRTC. */
export class MediaPublisher {
  #session: MediaSession;
  #iceServers: RTCIceServer[];
  #log: (operation: string, error?: boolean) => void;
  #browser?: Browser;
  #page?: Page;
  #unsubscribe?: () => void;
  #startup?: Promise<void>;
  #shutdown?: Promise<void>;
  #stopped = false;
  #reconnecting = false;
  #work: Promise<void> = Promise.resolve();
  #options: MediaOptions;

  constructor(session: MediaSession, iceServers: RTCIceServer[], log: (operation: string, error?: boolean) => void,
      options: MediaOptions) {
    this.#session = session;
    this.#iceServers = iceServers;
    this.#log = log;
    this.#options = options;
  }

  start(): Promise<void> {
    if (this.#startup || this.#stopped) throw new Error("Media publisher already started or stopped");
    this.#startup = this.#start();
    return this.#startup;
  }

  async #start(): Promise<void> {
    this.#log("media.chromium.starting");
    this.#browser = await chromium.launch({
      headless: true,
      args: ["--mute-audio", "--autoplay-policy=no-user-gesture-required", "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"],
    });
    if (this.#stopped) return;
    this.#browser.on("disconnected", () => {
      if (!this.#stopped) {
        this.#log("media.chromium.disconnected", true);
        void this.stop();
      }
    });
    this.#page = await this.#browser.newPage();
    // A locally fulfilled secure origin enables browser crypto without external HTTP traffic.
    await this.#page.route("https://studio-media.invalid/", route => route.fulfill({
      contentType: "text/html", body: "<!doctype html><html><body></body></html>",
    }));
    await this.#page.goto("https://studio-media.invalid/");
    await this.#page.exposeFunction("studioMediaSignal", (type: string, data: unknown, recipientId: string) => {
      if (this.#stopped || this.#reconnecting) return;
      try { this.#session.publish(type, data, recipientId); } catch {
        this.#log("media.signal.failed", true);
        void this.stop();
      }
    });
    await this.#page.exposeFunction("studioMediaLog", (operation: string, error: boolean) => {
      if (!this.#stopped) this.#log(operation, error);
    });
    await this.#page.exposeFunction("studioMediaEmit", (event: unknown) => {
      if (this.#stopped || !object(event)) return;
      try { this.#options.onEvent?.(event); }
      catch { this.#log("media.source.event.failed", true); }
    });
    await this.#page.addScriptTag({ content: this.#options.sourceScript });
    await this.#page.evaluate(installMediaWorker, {
      iceServers: this.#iceServers, initialState: this.#options.initialState,
      videoEncoding: this.#options.videoEncoding,
    });
    if (this.#stopped) return;
    this.#unsubscribe = this.#session.onEvent(event => {
      if (event.type === "reconnecting") this.#reconnecting = true;
      if (event.type === "joined") this.#reconnecting = false;
      if (["disconnected", "room.closed", "duplicate-session"].includes(event.type)) {
        void this.stop();
        return;
      }
      this.#enqueue(() => this.#handle(event));
    });
    await this.#enterLive();
    this.#log("media.source.started");
  }

  /** Stops tracks and closes this worker's Chromium. Signaling remains usable. */
  stop(): Promise<void> {
    if (this.#shutdown) return this.#shutdown;
    this.#stopped = true;
    this.#unsubscribe?.();
    this.#shutdown = (async () => {
      await this.#startup?.catch(() => {});
      try {
        if (this.#page && !this.#page.isClosed()) await this.#page.evaluate(() => window.studioMedia?.stop());
      } catch {
        // A crashed renderer is already gone; closing its browser is still required.
      } finally {
        await this.#browser?.close();
        this.#log("media.stopped");
      }
    })();
    return this.#shutdown;
  }

  async stats(): Promise<MediaStats[]> {
    if (this.#stopped || !this.#page) return [];
    return this.#page.evaluate(() => window.studioMedia.stats());
  }

  async update(state: JsonObject): Promise<void> {
    if (this.#stopped || !this.#page) throw new Error("Media is not started");
    await this.#command({ kind: "source.update", state });
  }

  #enqueue(action: () => Promise<void>): void {
    this.#work = this.#work.then(async () => {
      if (!this.#stopped) await action();
    }).catch(() => {
      if (!this.#stopped) {
        this.#log("media.signaling.failed", true);
        void this.stop();
      }
    });
  }

  async #enterLive(): Promise<void> {
    const room = this.#session.snapshot;
    if (room?.area !== "Live" || this.#stopped) return;
    await this.#command({
      kind: "enter", selfId: room.self.cid,
      participants: (room.pts ?? []).filter(p => p.cid !== room.self.cid && !p.l).map(p => p.cid),
    });
  }

  async #handle(event: SessionEvent): Promise<void> {
    if (event.type === "joined") { await this.#enterLive(); return; }
    if (event.type === "room.left" && object(event.data) && typeof event.data.cid === "string") {
      await this.#command({ kind: "leave", participantId: event.data.cid });
    } else if (event.type.startsWith("webrtc.p2p.") && object(event.data)) {
      await this.#command({ kind: "event", type: event.type, participantId: event.participantId, data: event.data });
    }
  }

  async #command(command: MediaCommand): Promise<void> {
    await this.#page?.evaluate(command => window.studioMedia.handle(command), command);
  }

}
