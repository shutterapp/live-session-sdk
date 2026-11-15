export interface GuestSessionAddress {
  baseUrl: string;
  sessionId: string;
  roomId: string;
  guestToken: string;
}

export function parseGuestUrl(input: string): GuestSessionAddress {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Expected an absolute guest session URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error("Guest URL must use HTTP(S), without user credentials or a fragment");
  }
  const match = /^(.*)\/sessions\/([1-9]\d*)\/?$/.exec(url.pathname);
  if (!match) throw new Error("Expected a /sessions/<sessionId> guest URL");
  const parameter = (key: string): string => {
    const values = url.searchParams.getAll(key);
    const value = values[0];
    if (values.length !== 1 || !value?.trim()) {
      throw new Error(`Guest URL requires exactly one non-empty ${key} parameter`);
    }
    return value;
  };
  return {
    baseUrl: url.origin + match[1],
    sessionId: match[2]!,
    roomId: parameter("roomId"),
    guestToken: parameter("g"),
  };
}
