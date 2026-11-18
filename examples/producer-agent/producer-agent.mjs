import { LiveSessionClient } from "@shutter-studio/live-session-sdk";
import { ProducerMedia } from "./dist/producer-media.js";

class ProducerAgent {
  shutdown = new AbortController();

  constructor(client) {
    this.client = client;
  }

  async hostSession(title) {
    const { shootId, roomId } = await this.client.createSession(title);
    const guestUrl = await this.client.getGuestInviteUrl(shootId);
    if (!guestUrl) throw new Error(`Shoot ${shootId} was created, but no guest invite is available.`);
    console.log(guestUrl);

    const room = await this.client.joinAsHost(roomId);
    console.error(`Producer joined as ${room.self.r} (${room.area}).`);
  }

  finish() {
    if (!this.shutdown.signal.aborted) this.client.closeRoom();
  }

  async run() {
    const disconnected = new Promise(resolve => this.client.on("disconnected", () => {
      this.shutdown.abort();
      resolve();
    }));
    const media = new ProducerMedia(this.client, text => {
      if (/^finish session[\s\p{P}]*$/iu.test(text.trimStart())) this.finish();
    });
    try {
      await media.start(this.shutdown.signal);
      await disconnected;
    } catch (error) {
      if (!this.shutdown.signal.aborted) throw error;
    } finally {
      await media.stop();
    }
  }
}

async function main() {
  const { STUDIO_BASE_URL: baseUrl, STUDIO_API_TOKEN: apiToken } = process.env;
  if (!baseUrl || !apiToken) throw new Error("Set STUDIO_BASE_URL and STUDIO_API_TOKEN.");

  const client = new LiveSessionClient({ baseUrl, apiToken, name: "Producer agent" });
  const producer = new ProducerAgent(client);
  const finish = () => producer.finish();
  try {
    await producer.hostSession(process.argv[2] ?? "Portrait");
    process.on("SIGINT", finish);
    process.on("SIGTERM", finish);
    await producer.run();
  } finally {
    process.off("SIGINT", finish);
    process.off("SIGTERM", finish);
    await client.close();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
