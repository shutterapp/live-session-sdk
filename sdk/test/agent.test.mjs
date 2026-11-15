import { test } from "node:test";
import assert from "node:assert/strict";
import { defineAgent, runAgent } from "../dist/index.js";
import { sessionServer } from "./fixture.mjs";
import { testSourceScript } from "./test-source.mjs";

test("managed runs enter Live before entry and remain alive after initialization returns", async t => {
  const peer = await sessionServer(t);
  const shutdown = new AbortController();
  t.after(() => shutdown.abort());
  const ready = Promise.withResolvers();
  let cleaned = false;
  const done = runAgent(defineAgent({
    entry: async ctx => {
      ctx.onShutdown(() => { cleaned = true; });
      ready.resolve(ctx);
    },
  }), { guestUrl: peer.guestUrl, signal: shutdown.signal });
  const ctx = await ready.promise;
  const published = peer.waitFor("pub");

  ctx.room.publish("agent.ready", {});
  const message = await published;
  shutdown.abort();
  await done;

  assert.equal(ctx.room.snapshot.area, "Live");
  assert.equal(message.type, "agent.ready");
  assert.equal(cleaned, true);
  assert.equal(ctx.signal.aborted, true);
  assert.equal("connect" in ctx.room, false);
});

test("waiting admission does not invoke entry until the server admits the participant", async t => {
  const peer = await sessionServer(t, { waiting: true });
  const shutdown = new AbortController();
  t.after(() => shutdown.abort());
  const ready = Promise.withResolvers();
  const knock = peer.waitFor("knock");
  let entered = false;
  const done = runAgent(defineAgent({
    entry: async ctx => { entered = true; ready.resolve(ctx); },
  }), { guestUrl: peer.guestUrl, signal: shutdown.signal });
  await knock;
  const beforeAdmission = entered;

  peer.admit();
  const ctx = await ready.promise;
  shutdown.abort();
  await done;

  assert.equal(beforeAdmission, false);
  assert.equal(ctx.room.snapshot.area, "Live");
});

test("entry failure runs every registered cleanup in reverse order and leaves the room", async t => {
  const peer = await sessionServer(t);
  const cleaned = [];
  const leave = peer.waitFor("leave");
  const agent = defineAgent({
    entry: async ctx => {
      ctx.onShutdown(() => { cleaned.push("first"); });
      ctx.onShutdown(() => { cleaned.push("second"); throw new Error("Cleanup failed"); });
      throw new Error("Initialization failed");
    },
  });

  await assert.rejects(runAgent(agent, { guestUrl: peer.guestUrl }), /Initialization failed/);

  assert.deepEqual(cleaned, ["second", "first"]);
  assert.equal((await leave).close, false);
});

test("async application event failures reject the run and clean up its resources", async t => {
  const peer = await sessionServer(t);
  const ready = Promise.withResolvers();
  let received;
  let cleaned = false;
  const done = runAgent(defineAgent({
    entry: async ctx => {
      ctx.onShutdown(() => { cleaned = true; });
      ctx.room.on("layout.changed", async event => {
        received = event;
        throw new Error("Layout handler failed");
      });
      ready.resolve();
    },
  }), { guestUrl: peer.guestUrl });
  const rejected = assert.rejects(done, /Layout handler failed/);
  await ready.promise;

  peer.send({ p: "host", event: { type: "layout.changed", data: { layout: "split" } } });
  await rejected;

  assert.deepEqual(received, { type: "layout.changed", data: { layout: "split" }, participantId: "host" });
  assert.equal(cleaned, true);
});

test("room closure reaches application handlers and ends the run normally", async t => {
  const peer = await sessionServer(t);
  const ready = Promise.withResolvers();
  let notified = false;
  let cleaned = false;
  const done = runAgent(defineAgent({
    entry: async ctx => {
      ctx.room.on("room.closed", async () => { notified = true; });
      ctx.onShutdown(() => { cleaned = true; });
      ready.resolve();
    },
  }), { guestUrl: peer.guestUrl });
  await ready.promise;

  peer.send({ type: "room.closed", data: {} });
  await done;

  assert.equal(notified, true);
  assert.equal(cleaned, true);
});

test("one definition creates independent concurrent runs", async t => {
  const first = await sessionServer(t);
  const second = await sessionServer(t);
  const firstStop = new AbortController();
  const secondStop = new AbortController();
  t.after(() => { firstStop.abort(); secondStop.abort(); });
  const ready = Promise.withResolvers();
  const contexts = [];
  const agent = defineAgent({
    entry: async ctx => {
      contexts.push(ctx);
      if (contexts.length === 2) ready.resolve();
    },
  });
  const firstRun = runAgent(agent, { guestUrl: first.guestUrl, signal: firstStop.signal });
  const secondRun = runAgent(agent, { guestUrl: second.guestUrl, signal: secondStop.signal });
  await ready.promise;

  firstStop.abort();
  await firstRun;
  const active = contexts.filter(ctx => !ctx.signal.aborted);
  secondStop.abort();
  await secondRun;

  assert.equal(active.length, 1);
  assert.notEqual(contexts[0].room, contexts[1].room);
});

test("transport recovery resumes the room without invoking entry a second time", { timeout: 10_000 }, async t => {
  const peer = await sessionServer(t);
  const shutdown = new AbortController();
  t.after(() => shutdown.abort());
  const ready = Promise.withResolvers();
  const resumed = Promise.withResolvers();
  let entries = 0;
  const done = runAgent(defineAgent({
    entry: async ctx => {
      entries++;
      ctx.room.on("joined", event => resumed.resolve(event));
      ready.resolve();
    },
  }), { guestUrl: peer.guestUrl, signal: shutdown.signal });
  await ready.promise;

  peer.close();
  const event = await resumed.promise;
  shutdown.abort();
  await done;

  assert.equal(entries, 1);
  assert.equal(event.data.area, "Live");
  assert.equal(peer.messages.filter(message => message.cmd === "resume").length, 1);
});

test("managed shutdown waits for Chromium media cleanup before completing", { timeout: 25_000 }, async t => {
  const peer = await sessionServer(t);
  const shutdown = new AbortController();
  t.after(() => shutdown.abort());
  const ready = Promise.withResolvers();
  const operations = [];
  const done = runAgent(defineAgent({
    entry: async ctx => {
      await ctx.room.startMedia({ sourceScript: testSourceScript, iceServers: [] });
      ready.resolve();
    },
  }), {
    guestUrl: peer.guestUrl, signal: shutdown.signal,
    connection: { logger: entry => operations.push(entry.operation) },
  });
  await ready.promise;

  shutdown.abort();
  await done;

  assert.ok(operations.indexOf("media.stopped") < operations.indexOf("agent.stopped"));
  assert.ok(operations.includes("media.stopped"));
});

test("context shutdown ends one run without a process signal", async t => {
  const peer = await sessionServer(t);
  let cleaned = false;

  await runAgent(defineAgent({
    entry: async ctx => {
      ctx.onShutdown(() => { cleaned = true; });
      ctx.shutdown();
    },
  }), { guestUrl: peer.guestUrl });

  assert.equal(cleaned, true);
});

test("shutdown disposes a resource acquired after cancellation during entry setup", async t => {
  const peer = await sessionServer(t);
  const shutdown = new AbortController();
  t.after(() => shutdown.abort());
  const started = Promise.withResolvers();
  const acquisition = Promise.withResolvers();
  let resource;
  let disposed;
  const done = runAgent(defineAgent({
    entry: async ctx => {
      ctx.onShutdown(() => { disposed = resource; });
      started.resolve();
      resource = await acquisition.promise;
    },
  }), { guestUrl: peer.guestUrl, signal: shutdown.signal });
  await started.promise;
  const acquired = { id: "late-resource" };

  shutdown.abort();
  acquisition.resolve(acquired);
  await done;

  assert.equal(disposed, acquired);
});

test("entry can register cleanup after an in-flight acquisition completes during shutdown", async t => {
  const peer = await sessionServer(t);
  const shutdown = new AbortController();
  t.after(() => shutdown.abort());
  const started = Promise.withResolvers();
  const acquisition = Promise.withResolvers();
  let disposed;
  const done = runAgent(defineAgent({
    entry: async ctx => {
      started.resolve();
      const resource = await acquisition.promise;
      ctx.onShutdown(() => { disposed = resource; });
    },
  }), { guestUrl: peer.guestUrl, signal: shutdown.signal });
  await started.promise;
  const acquired = { id: "late-registration" };

  shutdown.abort();
  acquisition.resolve(acquired);
  await done;

  assert.equal(disposed, acquired);
});
