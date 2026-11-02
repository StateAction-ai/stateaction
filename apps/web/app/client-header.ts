/** Sent on every browser mutation; the server rejects mutations without it. */
export const clientHeaders = {
  "Content-Type": "application/json",
  "X-StateAction-Client": "web",
} as const;
