import { chromium, type Browser, type Page } from "playwright";
import { object, type RoomSnapshot, type SessionEvent } from "./protocol.js";
import { installMediaWorker, type MediaCommand, type MediaStats } from "./media-worker.js";
import { ParakeetTranscriber, type ParakeetOptions, type Transcript } from "./parakeet.js";
import { installMatrixVideo } from "./matrix-video.js";

export interface HostTranscriptionOptions extends ParakeetOptions {
  /** Called once for each completed, nonempty host utterance. */
  onTranscript?: (transcript: Transcript) => void;
}

export interface SyntheticMediaOptions {
  /** Overrides ICE discovery, useful for custom TURN configurations or local peers. */
  iceServers?: RTCIceServer[];
  /** Full ICE HTTP endpoint; defaults to <base>/api/legacy-rooms/ice. */
  iceUrl?: string;
  /** Local-only English host transcription, rendered onto the outgoing video. */
  transcription?: HostTranscriptionOptions;
}

interface MediaSession {
  readonly snapshot: RoomSnapshot | undefined;
  onEvent(listener: (event: SessionEvent) => void): () => void;
  publish(type: string, data: unknown, recipientId?: string): void;
}

/** Node owns Live signaling; Chromium owns generated tracks and modern browser P2P WebRTC. */
export class SyntheticMediaPublisher {
  #session: MediaSession;
  #iceServers: RTCIceServer[];
  #log: (operation: string, error?: boolean) => void;
  #browser?: Browser;
  #page?: Page;
  #unsubscribe?: () => void;
  #startup?: Promise<void>;
  #shutdown?: Promise<void>;
  #stopped = false;
  #work: Promise<void> = Promise.resolve();
  #options: SyntheticMediaOptions;
  #transcriber?: ParakeetTranscriber;
  #hostId?: string;

  constructor(session: MediaSession, iceServers: RTCIceServer[], log: (operation: string, error?: boolean) => void,
      options: SyntheticMediaOptions = {}) {
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
    if (this.#options.transcription) {
      this.#transcriber = new ParakeetTranscriber(this.#options.transcription, result => {
        if (!this.#stopped && result.participantId === this.#hostId) {
          void this.#command({ kind: "caption", text: result.text }).catch(() => this.#log("stt.caption.failed", true));
          try { this.#options.transcription?.onTranscript?.(result); }
          catch { this.#log("stt.transcript.callback.failed", true); }
        }
      }, (operation, error) => {
        this.#log(operation, error);
        if (error && this.#page && !this.#stopped) {
          void this.#command({ kind: "transcription-unavailable" }).catch(() => {});
        }
      });
      await this.#transcriber.start();
      if (this.#stopped) return;
    }
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
    await this.#page.route("https://shutter-media.invalid/", route => route.fulfill({
      contentType: "text/html", body: "<!doctype html><html><body></body></html>",
    }));
    await this.#page.goto("https://shutter-media.invalid/");
    await this.#page.exposeFunction("shutterMediaSignal", (type: string, data: unknown, recipientId: string) => {
      if (this.#stopped) return;
      try { this.#session.publish(type, data, recipientId); } catch {
        this.#log("media.signal.failed", true);
        void this.stop();
      }
    });
    await this.#page.exposeFunction("shutterMediaLog", (operation: string, error: boolean) => {
      if (!this.#stopped) this.#log(operation, error);
    });
    await this.#page.exposeFunction("shutterHostAudio", (id: string, pcm16: string) => {
      if (this.#stopped || id !== this.#hostId || !this.#transcriber) return;
      const bytes = Buffer.from(pcm16, "base64");
      if (bytes.length !== 3_200) throw new Error("Invalid host audio frame");
      const samples = Float32Array.from({ length: 1_600 }, (_, index) => bytes.readInt16LE(index * 2) / 32768);
      this.#transcriber.accept({ participantId: id, sampleRate: 16_000, samples });
    });
    await this.#page.evaluate(installMatrixVideo, { captioning: Boolean(this.#transcriber) });
    await this.#page.evaluate(installMediaWorker, {
      iceServers: this.#iceServers, captureHostAudio: Boolean(this.#transcriber),
    });
    if (this.#stopped) return;
    this.#unsubscribe = this.#session.onEvent(event => {
      if (["disconnected", "room.closed", "duplicate-session"].includes(event.type)) {
        void this.stop();
        return;
      }
      this.#enqueue(() => this.#handle(event));
    });
    await this.#enterLive();
    this.#log("media.generators.started");
  }

  /** Stops tracks and closes this worker's Chromium. Signaling remains usable. */
  stop(): Promise<void> {
    if (this.#shutdown) return this.#shutdown;
    this.#stopped = true;
    this.#unsubscribe?.();
    const stopTranscriber = this.#transcriber?.stop();
    this.#shutdown = (async () => {
      await this.#startup?.catch(() => {});
      try {
        if (this.#page && !this.#page.isClosed()) await this.#page.evaluate(() => window.shutterMedia?.stop());
      } catch {
        // A crashed renderer is already gone; closing its browser is still required.
      } finally {
        await this.#browser?.close();
        await stopTranscriber;
        this.#log("media.stopped");
      }
    })();
    return this.#shutdown;
  }

  async stats(): Promise<MediaStats[]> {
    if (this.#stopped || !this.#page) return [];
    return this.#page.evaluate(() => window.shutterMedia.stats());
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
    await this.#updateHost();
    this.#announceDevices();
    await this.#command({
      kind: "enter", selfId: room.self.cid,
      participants: (room.pts ?? []).filter(p => p.cid !== room.self.cid && !p.l).map(p => p.cid),
    });
  }

  async #handle(event: SessionEvent): Promise<void> {
    if (event.type === "joined") { await this.#enterLive(); return; }
    if (event.type === "room.left" && object(event.data) && typeof event.data.cid === "string") {
      await this.#command({ kind: "leave", participantId: event.data.cid });
      await this.#updateHost();
    } else if (event.type === "room.joined") {
      await this.#updateHost();
    } else if (event.type.startsWith("webrtc.p2p.") && object(event.data)) {
      await this.#command({ kind: "event", type: event.type, participantId: event.participantId, data: event.data });
    }
  }

  async #updateHost(): Promise<void> {
    if (!this.#transcriber) return;
    const room = this.#session.snapshot;
    const hostId = room?.pts?.find(p => p.r === "Host" && p.cid !== room.self.cid && !p.l)?.cid;
    if (hostId === this.#hostId) return;
    this.#hostId = hostId;
    this.#transcriber.reset();
    await this.#command({ kind: "host", participantId: hostId });
    this.#log(hostId ? "stt.host.selected" : "stt.host.cleared");
  }

  async #command(command: MediaCommand): Promise<void> {
    await this.#page?.evaluate(command => window.shutterMedia.handle(command), command);
  }

  #announceDevices(): void {
    this.#session.publish("device.devices.list", [
      { id: "synthetic-mic", kind: "audioinput", label: "Silent microphone" },
      { id: "synthetic-camera", kind: "videoinput", label: "Matrix captions" },
    ]);
    this.#session.publish("device.devices.state", {
      audioinput: { current: "synthetic-mic", pending: null, paused: false, echoCancellation: false, noiseSuppression: false },
      videoinput: { current: "synthetic-camera", pending: null, paused: false },
      audiooutput: { current: null, pending: null, paused: true },
    });
  }
}
