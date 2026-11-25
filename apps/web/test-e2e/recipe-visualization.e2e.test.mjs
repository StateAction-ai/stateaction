import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { findChrome, launchChrome } from "./chrome.mjs";
import { SESSION, call, signIn, startStack } from "./harness.mjs";

const serverDir = fileURLToPath(
  new URL("../../../packages/server/", import.meta.url),
);
const requireServer = createRequire(join(serverDir, "package.json"));
const { S3Client, GetObjectCommand, PutObjectCommand } =
  requireServer("@aws-sdk/client-s3");
const recipePath = (jobId) => `/recipes/stub_local%401?job=${jobId}`;
const summary = '[aria-labelledby="recipe-stage-details"]';

test(
  "staff follow exact job recipes from recording operations and clip provenance",
  { timeout: 90_000 },
  async () => {
    const binary = await findChrome();
    assert.ok(binary, "Chromium is required for recipe visualization");
    const stack = await startStack({ storage: true });
    let chrome;
    try {
      const seed = (...args) =>
        JSON.parse(
          execFileSync(
            process.execPath,
            [
              "--conditions=react-server",
              "--import",
              "tsx",
              "test-auth/review-seed-cli.ts",
              "--recipe-visualization",
              ...args,
            ],
            {
              cwd: serverDir,
              env: {
                PATH: process.env.PATH,
                HOME: process.env.HOME,
                S3_ENDPOINT: stack.s3.endpoint,
                S3_BUCKET: stack.env.S3_BUCKET,
                S3_ACCESS_KEY_ID: stack.s3.accessKeyId,
                S3_SECRET_ACCESS_KEY: stack.s3.secretAccessKey,
                CATALOG_APP_URL: stack.db.appUrl,
                CATALOG_TEST_OWNER_URL: stack.db.ownerUrl,
                SEED_USERS: JSON.stringify(stack.users),
              },
              encoding: "utf8",
              timeout: 50_000,
            },
          ),
        );
      const { succeeded, active } = seed();
      const staff = await signIn(stack, "staff");
      const customer = await signIn(stack, "customer");
      const navigateHeaders = {
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
      };
      const denied = (path, jar) =>
        call(stack.origin, path, { jar, headers: navigateHeaders });
      assert.equal((await denied(recipePath(succeeded.jobId))).status, 307);
      assert.equal(
        (await denied(recipePath(succeeded.jobId), customer)).status,
        404,
      );
      assert.equal(
        (
          await denied(
            recipePath(succeeded.jobId).replace("stub_local", "wrong_recipe"),
            staff,
          )
        ).status,
        404,
      );
      assert.equal(
        (await denied(recipePath(succeeded.jobId), staff)).status,
        200,
      );
      chrome = await launchChrome(binary);
      const send = (method, params) => chrome.send(method, params);
      const ev = async (expression) => {
        const { result, exceptionDetails } = await send("Runtime.evaluate", {
          expression,
          returnByValue: true,
        });
        assert.equal(exceptionDetails, undefined, expression);
        return result.value;
      };
      const until = async (expression) => {
        const until = Date.now() + 15_000;
        while (Date.now() < until) {
          const value = await ev(expression);
          if (value) return value;
          await sleep(50);
        }
        assert.fail(
          `Browser did not render: ${expression}. Actual pathname: ${await ev("location.pathname + location.search + location.hash")}. Heading: ${await ev('document.querySelector("h1")?.textContent')}`,
        );
      };
      const ready = (selector) =>
        `document.querySelector(${JSON.stringify(selector)})`;
      const open = async (path, selector, destination = path) => {
        const { errorText } = await send("Page.navigate", {
          url: stack.origin + path,
        });
        assert.equal(errorText, undefined);
        await until(
          `document.readyState === "complete" && decodeURIComponent(location.pathname) + location.search + location.hash === ${JSON.stringify(decodeURIComponent(destination))} && !!${ready(selector)}`,
        );
      };
      const click = async (selector, expectedPath) => {
        await until(`!!${ready(selector)}`);
        const point = await ev(`(() => {
          const link = ${ready(selector)};
          link.scrollIntoView({ block: "center" });
          const box = link.getBoundingClientRect();
          const x = box.x + box.width / 2;
          const y = box.y + box.height / 2;
          return { x, y, reachable: link.contains(document.elementFromPoint(x, y)) };
        })()`);
        assert.ok(point.reachable, `Link must be clickable: ${selector}`);
        const { x, y } = point;
        await send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x,
          y,
          button: "left",
          clickCount: 1,
        });
        await send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x,
          y,
          button: "left",
          clickCount: 1,
        });
        await until(
          `decodeURIComponent(location.pathname) + location.search + location.hash === ${JSON.stringify(decodeURIComponent(expectedPath))} && !!${ready(summary)}`,
        );
      };
      const { success } = await send("Network.setCookie", {
        name: SESSION,
        value: staff.cookies.get(SESSION),
        url: stack.origin,
        httpOnly: true,
      });
      assert.ok(success);

      const width = (value) =>
        send("Emulation.setDeviceMetricsOverride", {
          width: value,
          height: 900,
          deviceScaleFactor: 1,
          mobile: false,
        });
      const capture = async (name, w) => {
        const sizes = await ev(
          "({ viewport: innerWidth, page: document.documentElement.clientWidth, content: document.documentElement.scrollWidth })",
        );
        assert.equal(sizes.viewport, w, `${name}: viewport width`);
        assert.equal(sizes.content, sizes.page, `${name}: no sideways scroll`);
        const output = process.env.RECIPE_VISUALIZATION_ARTIFACTS;
        if (!output) return;
        const { cssContentSize } = await send("Page.getLayoutMetrics");
        const { data } = await send("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: true,
          clip: {
            x: 0,
            y: 0,
            width: w,
            height: cssContentSize.height,
            scale: 1,
          },
        });
        await mkdir(output, { recursive: true });
        await writeFile(
          join(output, `${name}-${w}.png`),
          Buffer.from(data, "base64"),
        );
      };
      const path = recipePath(succeeded.jobId);
      const activePath = recipePath(active.jobId);
      await width(1280);
      const recordingPath = `/recordings/${succeeded.recordingId}`;
      const clipPath = `/clips/${succeeded.recordingId}`;
      await open("/recordings", `a[href="${recordingPath}"]`);
      await open(recordingPath, 'a[href$="/processing"]');
      await click(`main a[href="${path}"]`, path);
      assert.match(
        await ev('document.querySelector("main header").innerText'),
        /Succeeded/,
      );
      assert.match(
        await ev('document.querySelector("#stage-segment").innerText'),
        /Succeeded/,
      );
      assert.match(
        await ev('document.querySelector("#stage-caption").innerText'),
        /Succeeded/,
      );
      assert.match(
        await ev('document.querySelector("#stage-hand_pose").innerText'),
        /Succeeded/,
      );
      const processingPath = `${recordingPath}/clips/${succeeded.recordingId}/processing`;
      await open(
        processingPath,
        `a:is([href="${clipPath}"], [href^="${clipPath}?"])`,
      );
      await click(`main a[href="${path}"]`, path);
      await open(clipPath, '[data-testid="provenance"]');
      await click(
        `[data-testid="provenance"] a[href="${path}#stage-segment"]`,
        `${path}#stage-segment`,
      );

      const recordedModel = await ev(
        `[...document.querySelectorAll("#stage-segment dt")].find(dt => dt.textContent === "Recorded model")?.nextElementSibling.textContent`,
      );
      assert.ok(recordedModel && recordedModel !== "Not recorded");

      for (const w of [1280, 390]) {
        await width(w);
        await open(path, summary);
        await capture("succeeded", w);
        await open(activePath, summary);
        assert.match(
          await ev('document.querySelector("#stage-segment").innerText'),
          /Running/,
        );
        assert.match(
          await ev('document.querySelector("#stage-hand_pose").innerText'),
          /Running/,
        );
        await capture("running", w);
      }

      await click(
        'main header a[href$="view=recipe"]',
        `${activePath}&view=recipe`,
      );
      assert.match(
        await ev('document.querySelector("#stage-caption").innerText'),
        /Disabled/,
      );
      await click(`main header a[href="${activePath}"]`, activePath);
      assert.match(
        await ev('document.querySelector("#stage-segment").innerText'),
        /Running/,
      );

      seed(active.jobId);
      for (const w of [1280, 390]) {
        await width(w);
        await open(activePath, summary);
        assert.match(
          await ev('document.querySelector("#stage-segment").innerText'),
          /Failed[\s\S]*receipt_missing/,
        );
        assert.match(
          await ev('document.querySelector("#stage-caption").innerText'),
          /Not run/,
        );
        await capture("failed-and-not-run", w);
      }
      const storage = new S3Client({
        endpoint: stack.s3.endpoint,
        region: "us-east-1",
        forcePathStyle: true,
        credentials: {
          accessKeyId: stack.s3.accessKeyId,
          secretAccessKey: stack.s3.secretAccessKey,
        },
      });
      try {
        const file = {
          Bucket: stack.env.S3_BUCKET,
          Key: succeeded.segmentsKey,
        };
        const original = await storage.send(new GetObjectCommand(file));
        const text = await original.Body.transformToString();
        const changed = text.replace(
          `"model_name":"${recordedModel}"`,
          `"model_name":"${"x".repeat(recordedModel.length)}"`,
        );
        assert.notEqual(changed, text);
        assert.equal(Buffer.byteLength(changed), Buffer.byteLength(text));
        await storage.send(new PutObjectCommand({ ...file, Body: changed }));
        await open(path, summary);
        assert.match(
          await ev(
            'document.querySelector("#stage-segment details").textContent',
          ),
          /Recorded model[\s\S]*Not recorded/,
        );
        assert.doesNotMatch(
          await ev(
            'document.querySelector("#stage-segment details").textContent',
          ),
          new RegExp("x".repeat(recordedModel.length)),
        );
      } finally {
        storage.destroy();
      }
    } finally {
      await chrome?.close();
      await stack.stop();
    }
  },
);
