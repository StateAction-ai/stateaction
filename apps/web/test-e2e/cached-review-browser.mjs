// Locally publish an approved cached bundle into the disposable test stack.
// The bundle lives outside Git. This driver never runs a model.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { findChrome, launchChrome } from "./chrome.mjs";
import { SESSION, signIn, startStack } from "./harness.mjs";

assert.ok(
  process.argv[2],
  "Pass the approved local cached import bundle directory",
);
const bundle = resolve(process.argv[2]);
const { recordingId } = JSON.parse(
  await readFile(join(bundle, "import.json"), "utf8"),
);
assert.match(recordingId, /^[a-f0-9-]{36}$/);
const binary = await findChrome();
assert.ok(binary, "Chromium is required");
const stack = await startStack({
  storage: true,
  authOnly: true,
  storageProxy: (endpoint) => ({ endpoint, stop() {} }),
});
let chrome;
try {
  try {
    await promisify(execFile)(
      process.execPath,
      [
        "--conditions=react-server",
        "--import",
        "tsx",
        "src/cached-import-cli.ts",
        "publish",
        bundle,
        stack.users.staff.email,
        "--approve-for-data",
      ],
      {
        cwd: fileURLToPath(
          new URL("../../../packages/server/", import.meta.url),
        ),
        env: {
          ...stack.env,
          CACHED_IMPORT_OWNER_DATABASE_URL: stack.db.ownerUrl,
        },
        timeout: 90_000,
      },
    );
  } catch (error) {
    throw new Error(
      `Cached bundle failed local publication (exit ${error.code ?? "unknown"})`,
    );
  }
  chrome = await launchChrome(binary);
  const jar = await signIn(stack, "staff");
  const { success } = await chrome.send("Network.setCookie", {
    name: SESSION,
    value: jar.cookies.get(SESSION),
    url: stack.origin,
    httpOnly: true,
  });
  assert.ok(success);
  const ev = async (expression) => {
    const { result, exceptionDetails } = await chrome.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
    });
    assert.equal(exceptionDetails, undefined, expression);
    return result.value;
  };
  const until = async (expression) => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const value = await ev(expression);
      if (value) return value;
      await sleep(75);
    }
    assert.fail(expression);
  };
  const open = async (path, ready) => {
    await chrome.send("Page.navigate", { url: stack.origin + path });
    await until(
      `location.pathname + location.search === ${JSON.stringify(path)} && (${ready})`,
    );
    assert.ok(await ev("document.documentElement.scrollWidth <= innerWidth"));
  };
  for (const width of [1280, 390]) {
    await chrome.send("Emulation.setDeviceMetricsOverride", {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: width < 600,
    });
    const recording = "/recordings/" + recordingId;
    const processingLink = `document.querySelector('main a[href^="${recording}/clips/"][href$="/processing"]')`;
    await open(recording, `!!${processingLink}`);
    await until("document.querySelector('main video')?.readyState >= 1");
    const processing = await ev(processingLink + '.getAttribute("href")');
    const clipLink = "document.querySelector('main a[href^=\"/clips/\"]')";
    await open(processing, `!!${clipLink}`);
    assert.match(
      await ev('document.querySelector("main").innerText'),
      /FLORA Spike C \+ CPU hand tracking/,
    );
    assert.doesNotMatch(
      await ev('document.querySelector("main").innerText'),
      /Imported evidence|Cached import/,
    );
    const stageStates =
      await ev(`[...document.querySelectorAll("main section:has(h3)")].map(
      stage => stage.querySelector("h2")?.parentElement.innerText
    )`);
    assert.equal(stageStates.length, 3);
    assert.ok(stageStates.every((state) => state.includes("Output available")));
    const clipPath = await ev(clipLink + '.getAttribute("href")');
    const recipePath = await ev(
      `document.querySelector('main a[href^="/recipes/flora-spike-c"]')?.getAttribute('href')`,
    );
    assert.ok(recipePath);
    await open(
      recipePath,
      'document.querySelector("main h1")?.textContent.includes("FLORA Spike C")',
    );
    assert.match(
      await ev('document.querySelector("main figure").innerText'),
      /FLORA TempSeg[\s\S]*FLORA Captioner[\s\S]*MediaPipe/,
    );
    await open(
      clipPath,
      'document.querySelectorAll("[data-testid=rail-card]").length > 0',
    );
    await until(
      'document.querySelector("[data-testid=review-video]")?.readyState >= 1',
    );
    assert.equal(await ev("innerWidth"), width);
    console.log(
      `Cached recording, clip processing and review playback passed at ${width} px`,
    );
  }
} finally {
  await chrome?.close();
  await stack.stop();
}
