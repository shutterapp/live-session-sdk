import { createSession, getGuestInviteUrl } from "@shutter-studio/live-session-sdk";

async function main() {
  const { STUDIO_BASE_URL: baseUrl, STUDIO_API_TOKEN: apiToken } = process.env;
  if (!baseUrl || !apiToken) throw new Error("Set STUDIO_BASE_URL and STUDIO_API_TOKEN.");

  const access = { baseUrl, apiToken };
  const { shootId } = await createSession(access, process.argv[2] ?? "Portrait");
  const invite = await getGuestInviteUrl(access, shootId);
  if (!invite) throw new Error(`Shoot ${shootId} was created, but no guest invite is available.`);
  console.log(invite);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
