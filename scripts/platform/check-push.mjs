import { readFileSync } from "node:fs";
// Git supplies one ref-update per line to pre-push, including deletes/force pushes.
const input = readFileSync(0, "utf8");
if (input.length > 65536) throw new Error("Too many push updates to verify");
for (const line of input.split("\n").filter(Boolean)) {
  const fields = line.trim().split(/\s+/);
  if (fields.length !== 4) throw new Error("Malformed Git pre-push input");
  if (fields[2] === "refs/heads/main") {
    console.error(
      "Direct pushes to main are prohibited. Push a ticket branch and merge its single Linear-ticket PR after required CI.",
    );
    process.exitCode = 1;
  }
}
