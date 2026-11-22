// Node-only part of the SA-120 hook. Kept in its own module and imported only
// when NEXT_RUNTIME is "nodejs", so the Edge/webpack analysis of
// instrumentation.ts never reaches pg or other Node-only code.
import { Server } from "node:http";
import {
  installClientAddressPolicy,
  parseTrustedProxies,
} from "@stateaction/server/client-address";

export function installNodeClientAddressPolicy(): void {
  installClientAddressPolicy(
    Server.prototype,
    parseTrustedProxies(process.env),
  );
}
