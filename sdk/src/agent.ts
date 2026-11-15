import { LiveSessionClient, type ClientOptions } from "./client.js";
import type { EventHandler, RoomSnapshot, SessionEvent } from "./protocol.js";

/** Room capabilities shared with the low-level client, without connection ownership. */
export interface Room extends Pick<LiveSessionClient,
  "deviceId" | "onEvent" | "on" | "command" | "sendCommand" |
  "startRecording" | "stopRecording" | "publish" | "startMedia" | "updateMedia" | "stopMedia"> {
  readonly snapshot: RoomSnapshot;
}

export interface RunContext {
  readonly room: Room;
  readonly signal: AbortSignal;
  onShutdown(cleanup: () => void | Promise<void>): void;
  /** Requests shutdown. runAgent() awaits the completed cleanup. */
  shutdown(): void;
}

export interface AgentDefinition {
  /** Called once after Live admission. Returning completes setup, not the run. */
  entry(context: RunContext): Promise<void>;
}

export interface RunOptions {
  guestUrl: string;
  connection?: ClientOptions;
  signal?: AbortSignal;
}

export function defineAgent(definition: AgentDefinition): AgentDefinition {
  return definition;
}

/** Runs one assignment. The definition contains no room credentials or process policy. */
export async function runAgent(definition: AgentDefinition, options: RunOptions): Promise<void> {
  if (options.signal?.aborted) return;
  const client = new LiveSessionClient(options.guestUrl, options.connection);
  const controller = new AbortController();
  let admit!: () => void;
  let finish!: () => void;
  const admitted = new Promise<void>(resolve => { admit = resolve; });
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const cleanups: (() => void | Promise<void>)[] = [];
  const subscriptions = new Set<() => void>();
  const handlers = new Set<Promise<void>>();
  let stopping = false;
  let failure: unknown;
  let entry: Promise<void> | undefined;

  const stop = (error?: unknown) => {
    if (error !== undefined && failure === undefined) failure = error;
    if (stopping) return;
    stopping = true;
    controller.abort();
    try { client.disconnect(); }
    catch (error) { failure ??= error; }
    finish();
  };
  const onAbort = () => stop();
  options.signal?.addEventListener("abort", onAbort, { once: true });

  const room: Room = {
    get snapshot() { return client.snapshot!; },
    get deviceId() { return client.deviceId; },
    onEvent(listener) {
      const unsubscribe = client.onEvent(event => {
        if (controller.signal.aborted) return;
        const task = Promise.resolve().then(() => listener(event));
        handlers.add(task);
        void task.catch(error => { if (!stopping) stop(error); }).finally(() => handlers.delete(task));
      });
      const remove = () => { unsubscribe(); subscriptions.delete(remove); };
      subscriptions.add(remove);
      return remove;
    },
    on<T extends string>(type: T, listener: EventHandler<T>) {
      return room.onEvent(event => {
        if (event.type === type) return listener(event as SessionEvent<T>);
      });
    },
    command: client.command.bind(client),
    sendCommand: client.sendCommand.bind(client),
    startRecording: client.startRecording.bind(client),
    stopRecording: client.stopRecording.bind(client),
    publish: client.publish.bind(client),
    startMedia: client.startMedia.bind(client),
    updateMedia: client.updateMedia.bind(client),
    stopMedia: client.stopMedia.bind(client),
  };
  const context: RunContext = {
    room, signal: controller.signal,
    onShutdown(cleanup) {
      if (stopping) throw new Error("Cannot register cleanup after shutdown");
      cleanups.push(cleanup);
    },
    shutdown: () => stop(),
  };
  const unsubscribe = client.onEvent(event => {
    if (event.type === "joined" && client.snapshot?.area === "Live") admit();
    // Deliver terminal events to application handlers before ending the run.
    if (event.type === "room.closed") queueMicrotask(() => { if (!stopping) stop(); });
    if (event.type === "duplicate-session") queueMicrotask(() => {
      if (!stopping) stop(new Error("Live connection rejected: duplicate session"));
    });
    if (event.type === "disconnected") queueMicrotask(() => {
      if (!stopping) stop(new Error("Live connection closed"));
    });
  });

  try {
    if (options.signal?.aborted) stop();
    if (!stopping) {
      const snapshot = await client.connect();
      if (!stopping && snapshot.area !== "Live") await client.knock();
      await Promise.race([admitted, finished]);
      if (!stopping) {
        options.connection?.logger?.({ level: "info", operation: "agent.started" });
        entry = Promise.resolve().then(() => definition.entry(context)).catch(error => { if (!stopping) stop(error); });
        await finished;
      }
    }
  } catch (error) {
    if (!stopping) stop(error);
  } finally {
    stop();
    options.signal?.removeEventListener("abort", onAbort);
    unsubscribe();
    for (const remove of subscriptions) remove();
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup(); }
      catch (error) { failure ??= error; }
    }
    await entry;
    await Promise.allSettled(handlers);
    try { await client.close(); }
    catch (error) { failure ??= error; }
    options.connection?.logger?.({ level: failure === undefined ? "info" : "error", operation: "agent.stopped" });
  }
  if (failure !== undefined) throw failure;
}
