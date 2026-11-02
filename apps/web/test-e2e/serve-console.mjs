// Starts the real stack and keeps it running for manual/agent-browser checks.
// Prints one JSON line (origin, seeded emails, password) to stdout; stop with
// SIGTERM. The password is a throwaway for this ephemeral database only.
import { startStack } from "./harness.mjs";
const stack = await startStack();
console.log(
  JSON.stringify({
    origin: stack.origin,
    password: stack.password,
    users: stack.users,
  }),
);
const done = async () => {
  await stack.stop();
  process.exit(0);
};
process.on("SIGTERM", done);
process.on("SIGINT", done);
setInterval(() => {}, 1 << 30);
