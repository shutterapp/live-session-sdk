import { object } from "./protocol.js";

export interface ApiAccess { baseUrl: string; apiToken: string }
export interface CreateSessionOptions { arborWorkspaceId?: string }
export interface SessionIds { shootId: string; sessionId: string; roomId: string; roomUrl: string | null }

export function apiBase(access: ApiAccess): string {
  let url: URL;
  try { url = new URL(access.baseUrl); } catch { throw new Error("Invalid API base URL"); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
      url.username || url.password || url.search || url.hash) throw new Error("Invalid API base URL");
  if (!access.apiToken?.trim()) throw new Error("An API token is required");
  return url.href.replace(/\/+$/, "");
}

async function dashboard(access: ApiAccess, path: string, body?: object): Promise<Record<string, unknown>> {
  const url = `${apiBase(access)}/api/v1/platform/${path}`;
  const response = await fetch(url, {
    method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${access.apiToken}`, ...(body && { "Content-Type": "application/json" }) },
    body: body && JSON.stringify(body),
  }).catch(() => { throw new Error("Dashboard request failed"); });
  if (!response.ok) throw new Error(`Dashboard request rejected (HTTP ${response.status})`);
  const data: unknown = await response.json().catch(() => null);
  if (!object(data)) throw new Error("Invalid Dashboard response");
  return data;
}

/** Creates a photo session for a guest to be invited later. Never retried automatically. */
export async function createSession(access: ApiAccess, title: string, options: CreateSessionOptions = {}): Promise<SessionIds> {
  if (!title.trim()) throw new Error("A session title is required");
  const { shootId, sessionId, roomId, roomUrl } = await dashboard(access, "sessions", {
    modelName: title, hiresType: 1, inviteSubjectLater: true,
    arborWorkspaceId: options.arborWorkspaceId,
  });
  if (typeof shootId !== "string" || !/^[1-9]\d*$/.test(shootId) ||
      typeof sessionId !== "string" || !/^[1-9]\d*$/.test(sessionId) ||
      typeof roomId !== "string" || !roomId.trim()) throw new Error("Invalid session creation response");
  if (roomUrl != null && (typeof roomUrl !== "string" || !/^https?:\/\//i.test(roomUrl))) {
    throw new Error("Invalid host room URL");
  }
  return { shootId, sessionId, roomId, roomUrl: roomUrl ?? null };
}

/** Returns the server's share link for the shoot without entering its room. */
export async function getGuestInviteUrl(access: ApiAccess, shootId: string): Promise<string | null> {
  if (!/^[1-9]\d*$/.test(shootId)) throw new Error("Invalid shoot ID");
  const { guestShareUrl } = await dashboard(access, `shoots/${shootId}`);
  if (guestShareUrl == null) return null;
  if (typeof guestShareUrl !== "string" || !/^https?:\/\//i.test(guestShareUrl)) throw new Error("Invalid guest share URL");
  return guestShareUrl;
}

/** Returns a fresh browser Host link for the shoot's latest session, without joining. */
export async function getHostJoinUrl(access: ApiAccess, shootId: string): Promise<string | null> {
  if (!/^[1-9]\d*$/.test(shootId)) throw new Error("Invalid shoot ID");
  const { hostJoinUrl } = await dashboard(access, `shoots/${shootId}`);
  if (hostJoinUrl == null) return null;
  if (typeof hostJoinUrl !== "string" || !/^https?:\/\//i.test(hostJoinUrl)) throw new Error("Invalid host join URL");
  return hostJoinUrl;
}
