import { object } from "./protocol.js";

export interface ApiAccess { baseUrl: string; apiToken: string }
export interface CreateSessionOptions {
  arborWorkspaceId?: string;
  arborAutoUpload?: boolean | null;
}
export interface SessionIds { shootId: string; sessionId: string; roomId: string; roomUrl: string | null }
export interface SessionDetails {
  shootId: string;
  guestShareUrl: string | null;
  hostJoinUrl: string | null;
  arborAutoUpload: boolean | null;
  arborWorkspaceId: string | null;
}

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
    arborAutoUpload: options.arborAutoUpload,
  });
  if (typeof shootId !== "string" || !/^[1-9]\d*$/.test(shootId) ||
      typeof sessionId !== "string" || !/^[1-9]\d*$/.test(sessionId) ||
      typeof roomId !== "string" || !roomId.trim()) throw new Error("Invalid session creation response");
  if (roomUrl != null && (typeof roomUrl !== "string" || !/^https?:\/\//i.test(roomUrl))) {
    throw new Error("Invalid host room URL");
  }
  return { shootId, sessionId, roomId, roomUrl: roomUrl ?? null };
}

/** Reads shoot settings and links to its latest session without joining. */
export async function getSession(access: ApiAccess, shootId: string): Promise<SessionDetails> {
  if (!/^[1-9]\d*$/.test(shootId)) throw new Error("Invalid shoot ID");
  const { guestShareUrl, hostJoinUrl, arborAutoUpload, arborWorkspaceId } = await dashboard(access, `shoots/${shootId}`);
  if (arborAutoUpload != null && typeof arborAutoUpload !== "boolean") throw new Error("Invalid Arbor auto-upload setting");
  if (arborWorkspaceId != null && typeof arborWorkspaceId !== "string") throw new Error("Invalid Arbor workspace ID");
  return {
    shootId,
    guestShareUrl: readLink(guestShareUrl, "guest share URL"),
    hostJoinUrl: readLink(hostJoinUrl, "host join URL"),
    arborAutoUpload: arborAutoUpload ?? null,
    arborWorkspaceId: arborWorkspaceId ?? null,
  };
}

function readLink(value: unknown, label: string): string | null {
  if (value == null) return null;
  if (typeof value !== "string" || !/^https?:\/\//i.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}

/** Thin wrapper around {@link getSession} that returns only the guest invite URL. Prefer `getSession` directly. */
export async function getGuestInviteUrl(access: ApiAccess, shootId: string): Promise<string | null> {
  return (await getSession(access, shootId)).guestShareUrl;
}

/** Thin wrapper around {@link getSession} that returns only the host join URL. Prefer `getSession` directly. */
export async function getHostJoinUrl(access: ApiAccess, shootId: string): Promise<string | null> {
  return (await getSession(access, shootId)).hostJoinUrl;
}
