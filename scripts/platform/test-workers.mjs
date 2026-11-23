#!/usr/bin/env node
// Prints the declared worker count of one fixture suite (scripts/platform/test-workers.json).
// `test-workers.mjs <suite>` -> workers; `--target <suite>` -> targetWorkers.
import { readFileSync } from "node:fs";

const file = new URL("./test-workers.json", import.meta.url);
const args = process.argv.slice(2);
const target = args[0] === "--target";
const suite = args[target ? 1 : 0];
const config = JSON.parse(readFileSync(file, "utf8"));
const entry = config.suites[suite];
if (!entry) {
  console.error(`unknown suite ${suite}`);
  process.exit(2);
}
console.log(String(target ? entry.targetWorkers : entry.workers));
