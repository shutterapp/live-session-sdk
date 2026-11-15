export type JsonObject = Record<string, unknown>;
export type RoomArea = "Setup" | "WaitingRoom" | "Live";

export interface Participant {
  cid: string;
  uid: number;
  did: number;
  r: "Host" | "Guest";
  p: { name?: string | null; avatarUrl?: string | null };
  l?: boolean | null;
}

export interface RoomSnapshot {
  area: RoomArea;
  sid: string;
  self: Participant;
  pts?: Participant[];
  type?: string;
  state?: Record<string, JsonObject>;
  recording?: JsonObject;
  session?: JsonObject;
  lk?: { url: string; token: string };
}

export interface SessionEvent {
  type: string;
  data: unknown;
  participantId?: string;
}

export function object(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function participant(value: unknown): value is Participant {
  return object(value) && typeof value.cid === "string" && typeof value.uid === "number" &&
    typeof value.did === "number" && (value.r === "Host" || value.r === "Guest") && object(value.p);
}

export function roomSnapshot(value: unknown): RoomSnapshot {
  if (!object(value) || !["Setup", "WaitingRoom", "Live"].includes(String(value.area)) ||
      typeof value.sid !== "string" || !value.sid || !participant(value.self) ||
      (value.pts !== undefined && (!Array.isArray(value.pts) || !value.pts.every(participant)))) {
    throw new Error("Live API returned an invalid room snapshot");
  }
  return value as unknown as RoomSnapshot;
}
