// SA-120: rewrite x-forwarded-for from the real socket peer before any route
// runs, so the sign-in rate limiter cannot be bypassed by a forged header.
// The Node-only code lives in instrumentation-node.ts and is imported inside
// this exact `if`, so the Edge compile prunes it (an early return does not).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { installNodeClientAddressPolicy } = await import(
      "./instrumentation-node"
    );
    installNodeClientAddressPolicy();
  }
}
