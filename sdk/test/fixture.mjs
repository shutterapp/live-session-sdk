import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocketServer } from "ws";

export const self = { cid: "201|9", uid: 201, did: 9, r: "Guest", p: { name: "Agent" } };
export const snapshot = { area: "Setup", sid: "room-a|private-sid", self };

// Capturing HTTP and WebSocket peers are the only test doubles; the SDK and network are real.
export async function sessionServer(t, options = {}) {
  const requests = [];
  const messages = [];
  const sockets = new Set();
  const waiters = [];
  let room = snapshot;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, path: req.url, body: body ? JSON.parse(body) : undefined, headers: req.headers });
    if (options.redirect) {
      res.writeHead(307, { Location: "/must-not-follow" }).end();
      return;
    }
    res.writeHead(options.httpStatus ?? 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(options.responses?.[req.url] ?? (options.invalidCredentials ? { ws: {} } : {
      deviceId: "device-agent",
      session: { role: "subject", token: "private-access-token" },
      ws: { url: "wss://legacy.example/ws", token: "201|9" },
      lk: { url: "wss://media.example", token: "private-media-token" },
    })));
  });
  const ws = new WebSocketServer({ server, path: "/api/live/ws" });
  ws.on("connection", socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("message", raw => {
      const message = JSON.parse(String(raw));
      messages.push(message);
      for (const waiter of [...waiters]) {
        if (waiter.cmd === message.cmd) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(message);
        }
      }
      const reply = data => socket.send(JSON.stringify({
        type: "resp", cmd: message.cmd === "knock" ? "join" : message.cmd,
        rid: options.numericRid ? Number(message.mid) : message.mid, data,
      }));
      if (message.cmd === "join" && !options.silentJoin) {
        if (options.joinError) socket.send(JSON.stringify({ type: "resp", rid: message.mid, error: "forbidden" }));
        else reply(options.malformedSnapshot ? { area: "Live" } : options.joinSnapshot ?? snapshot);
      }
      if (message.cmd === "resume") reply(room);
      if (message.cmd === "knock") {
        room = { ...snapshot, area: options.waiting ? "WaitingRoom" : "Live", pts: options.participants ?? [self] };
        reply(room);
      }
      if (message.cmd === "ping" && !options.silentPing) reply({ ts: Date.now(), offset: 0 });
      if (message.cmd === options.command) {
        if (options.commandError) socket.send(JSON.stringify({ type: "resp", rid: message.mid, error: "forbidden" }));
        else reply(options.commandResult);
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    ws.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return {
    baseUrl, requests, messages,
    guestUrl: `${baseUrl}/sessions/248208?roomId=room-a&g=private-guest-token`,
    send: data => { for (const socket of sockets) socket.send(JSON.stringify(data)); },
    raw: text => { for (const socket of sockets) socket.send(text); },
    close: () => { for (const socket of sockets) socket.close(1001); },
    admit: () => {
      room = { ...room, area: "Live", pts: options.participants ?? [self] };
      for (const socket of sockets) socket.send(JSON.stringify({ type: "resp", cmd: "join", data: room }));
    },
    waitFor: cmd => new Promise(resolve => waiters.push({ cmd, resolve })),
  };
}
