import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Real loopback artifact server; only the remote model host is replaced.
export async function downloadServer(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "live-session-model-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const firstByte = Promise.withResolvers();
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(options.status ?? 200);
    if (options.pause) {
      response.write("a");
      firstByte.resolve();
    } else {
      response.end(options.bytes ?? "abc");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return {
    directory, firstByte: firstByte.promise, requests: () => requests,
    file: {
      name: "model.onnx", size: 3,
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      url: `http://127.0.0.1:${server.address().port}/model.onnx`,
    },
  };
}
