import { LiveSessionClient } from "@shutter-studio/live-session-sdk";

const client = new LiveSessionClient({
  baseUrl: process.env.STUDIO_BASE_URL,
  apiToken: process.env.STUDIO_API_TOKEN,
});

const { shootId, roomUrl } = await client.createSession(process.argv[2] ?? "Portrait");
const guestUrl = await client.getGuestInviteUrl(shootId);

console.log(`Host:  ${roomUrl ?? "Not available"}`);
console.log(`Guest: ${guestUrl ?? "Not available"}`);
