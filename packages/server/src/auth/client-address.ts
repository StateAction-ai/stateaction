import { BlockList, isIP } from "node:net";
import type { IncomingMessage } from "node:http";
import { AuthConfigError } from "./config.js";

/**
 * Client address for the sign-in rate limiter (SA-120).
 *
 * Better Auth keys its limiter on a single-valued `x-forwarded-for`. Anyone
 * who reaches the port directly could choose that value, so before any route
 * runs we rewrite the header from the real socket peer:
 *
 * - peer not in `AUTH_TRUSTED_PROXIES` (the default: empty, nobody trusted):
 *   the header is replaced by the peer address; whatever the client sent is
 *   discarded;
 * - peer is a trusted proxy: the header chain is walked from the right,
 *   skipping trusted proxies, and the first untrusted address is the client.
 *   A malformed chain is ignored and the peer address is used.
 *
 * Limits, windows and attempt counts are untouched.
 */
export const TRUSTED_PROXIES_SETTING = "AUTH_TRUSTED_PROXIES";

export type TrustedProxies = {
  readonly entries: readonly string[];
  isTrusted(address: string): boolean;
};

export const NO_TRUSTED_PROXIES: TrustedProxies = {
  entries: [],
  isTrusted: () => false,
};

/** Canonical form: IPv4-mapped IPv6 becomes IPv4; IPv6 is lower-cased. */
export function normalizeAddress(value: string): string | null {
  let v = value.trim();
  if (v.startsWith("[") && v.endsWith("]")) v = v.slice(1, -1);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(v);
  if (mapped) v = mapped[1]!;
  return isIP(v) ? v.toLowerCase() : null;
}

const hostedEnv = (env: Readonly<Record<string, string | undefined>>) =>
  env.APP_ENV === "production" ||
  env.APP_ENV === "staging" ||
  env.RENDER === "true";

/**
 * Loopback and unspecified probes. Every family is tested against every probe
 * because Node's BlockList treats IPv4-mapped IPv6 (`::ffff:0:0/96`,
 * `::ffff:7f00:0/104`) as IPv4 and an IPv6 range can contain IPv4 loopback.
 */
const LOOPBACK_PROBES: readonly (readonly [string, "ipv4" | "ipv6"])[] = [
  ["127.0.0.1", "ipv4"],
  ["127.255.255.255", "ipv4"],
  ["0.0.0.0", "ipv4"],
  ["::1", "ipv6"],
  ["::", "ipv6"],
  ["::ffff:127.0.0.1", "ipv6"],
  ["::ffff:0.0.0.0", "ipv6"],
];

/** True when the range contains a loopback or unspecified address. */
function containsLoopback(family: 4 | 6, address: string, prefix: number) {
  const list = new BlockList();
  list.addSubnet(address, prefix, family === 4 ? "ipv4" : "ipv6");
  return LOOPBACK_PROBES.some(([probe, kind]) => list.check(probe, kind));
}

/**
 * Parses `AUTH_TRUSTED_PROXIES` (comma-separated IPs or CIDRs). Empty or
 * unset trusts nothing. Throws `AuthConfigError` for malformed entries, for a
 * zero-length prefix (trusts everyone), and, on hosted services (production,
 * staging or Render), for any loopback entry: loopback trust exists only for
 * the local and test harnesses that simulate client addresses.
 */
export function parseTrustedProxies(
  env: Readonly<Record<string, string | undefined>>,
): TrustedProxies {
  const raw = (env[TRUSTED_PROXIES_SETTING] ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  if (raw.length === 0) return NO_TRUSTED_PROXIES;
  const hosted = hostedEnv(env);
  const list = new BlockList();
  const entries: string[] = [];
  for (const item of raw) {
    const [addr, bits, extra] = item.split("/");
    const ip = addr === undefined ? null : normalizeAddress(addr);
    if (ip === null || extra !== undefined)
      throw new AuthConfigError(
        `${TRUSTED_PROXIES_SETTING} entries must be IP addresses or CIDRs`,
      );
    const family = isIP(ip) === 4 ? 4 : 6;
    const max = family === 4 ? 32 : 128;
    let prefix = max;
    if (bits !== undefined) {
      if (!/^\d{1,3}$/.test(bits) || Number(bits) > max)
        throw new AuthConfigError(
          `${TRUSTED_PROXIES_SETTING} has an invalid prefix length`,
        );
      prefix = Number(bits);
    }
    if (prefix === 0)
      throw new AuthConfigError(
        `${TRUSTED_PROXIES_SETTING} must not trust every address (prefix length 0)`,
      );
    if (hosted && containsLoopback(family, ip, prefix))
      throw new AuthConfigError(
        `${TRUSTED_PROXIES_SETTING} must not trust loopback on a hosted service`,
      );
    list.addSubnet(ip, prefix, family === 4 ? "ipv4" : "ipv6");
    entries.push(prefix === max ? ip : `${ip}/${prefix}`);
  }
  return {
    entries,
    isTrusted(address) {
      const ip = normalizeAddress(address);
      return ip !== null && list.check(ip, isIP(ip) === 4 ? "ipv4" : "ipv6");
    },
  };
}

/**
 * The address the limiter should key on. `peer` is the socket's remote
 * address; `forwardedFor` the raw header (duplicates joined with a comma).
 * Returns null only when the peer itself is unknown.
 */
export function resolveClientAddress(
  peer: string | undefined,
  forwardedFor: string | string[] | undefined,
  trusted: TrustedProxies,
): string | null {
  const peerIp = peer === undefined ? null : normalizeAddress(peer);
  if (peerIp === null) return null;
  if (!trusted.isTrusted(peerIp) || forwardedFor === undefined) return peerIp;
  const chain = (
    Array.isArray(forwardedFor) ? forwardedFor.join(",") : forwardedFor
  )
    .split(",")
    .map((v) => normalizeAddress(v));
  // Any malformed hop makes the whole header untrustworthy.
  if (chain.length === 0 || chain.some((v) => v === null)) return peerIp;
  for (let i = chain.length - 1; i >= 0; i--) {
    const hop = chain[i]!;
    if (!trusted.isTrusted(hop)) return hop;
  }
  return peerIp; // every hop is a trusted proxy
}

/**
 * Rewrites `x-forwarded-for` on a Node request from its socket peer. Never
 * throws (it runs inside the HTTP server's `emit`): on any failure the header
 * falls back to the peer address, or is removed when the peer is unusable.
 */
export function applyClientAddress(
  req: Pick<IncomingMessage, "headers" | "socket">,
  trusted: TrustedProxies,
): void {
  let peer: string | null = null;
  try {
    const remote = req.socket?.remoteAddress;
    peer = remote === undefined ? null : normalizeAddress(remote);
    const client = resolveClientAddress(
      req.socket?.remoteAddress,
      req.headers["x-forwarded-for"],
      trusted,
    );
    if (client === null) delete req.headers["x-forwarded-for"];
    else req.headers["x-forwarded-for"] = client;
  } catch {
    try {
      if (peer === null) delete req.headers["x-forwarded-for"];
      else req.headers["x-forwarded-for"] = peer;
    } catch {
      // Nothing more can be done; never throw into the HTTP parser.
    }
  }
}

// Method syntax keeps parameters bivariant so `http.Server` (string events)
// and plain EventEmitters both satisfy it.
type Emitter = {
  emit(event: any, ...args: any[]): boolean;
};
const installed = Symbol.for("stateaction.clientAddress");

/**
 * Wraps `emit` on a Node HTTP server (or prototype) so every `request` is
 * rewritten before Next.js or any handler reads it. Idempotent.
 */
export function installClientAddressPolicy(
  target: Emitter & { [installed]?: true },
  trusted: TrustedProxies,
): void {
  if (target[installed]) return;
  const emit = target.emit;
  target.emit = function (this: unknown, event, ...args) {
    if (event === "request" && args[0])
      applyClientAddress(args[0] as IncomingMessage, trusted);
    return emit.call(this, event, ...args);
  };
  target[installed] = true;
}
