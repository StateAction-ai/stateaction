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
const graph = '[aria-label="Recipe graph"]';
const panel = (step) => `[data-step-details="${step}"]`;

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
      const click = async (selector) => {
        await until(`(() => {
          const element = ${ready(selector)};
          return !!element && Object.keys(element).some(key => key.startsWith("__reactProps$"));
        })()`);
        await ev(
          `${ready(selector)}.scrollIntoView({ block: "center", inline: "center", behavior: "instant" })`,
        );
        const point = await until(`(() => {
          const link = ${ready(selector)};
          const points = [...link.getClientRects()].map(box => ({
            x: box.x + box.width / 2,
            y: box.y + box.height / 2,
          }));
          return points.find(({ x, y }) => link.contains(document.elementFromPoint(x, y)));
        })()`);
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
      const recordingPath = `/recordings/${succeeded.recordingId}`;
      const reviewPath = `/clips/${succeeded.recordingId}`;
      const processingPath = `${recordingPath}/clips/${succeeded.recordingId}/processing`;
      const definitionPath = "/recipes/stub_local%401";
      async function inspect(step) {
        await click(`button[data-step="${step}"]`);
        await until(`${ready(panel(step))} === document.activeElement`);
      }

      for (const w of [1280, 390]) {
        await width(w);
        await open("/recipes/minimal_stub%401", graph);
        assert.match(
          await ev("document.querySelector('main').innerText"),
          /Read-only preview/,
        );
        assert.deepEqual(
          await ev(
            '[...document.querySelectorAll("button[data-step]")].map(node => node.dataset.step)',
          ),
          ["$source", "clips", "$clips", "hands"],
        );
        await inspect("hands");
        await capture("recipe-minimal", w);
        await open("/recipes/egocentric_default%401", graph);
        assert.equal(
          await ev(
            'document.querySelectorAll("main svg path[marker-end]").length',
          ),
          7,
        );
        await capture("recipe-branching", w);

        await open(recordingPath, graph);
        assert.deepEqual(
          await ev(
            '[...document.querySelectorAll("button[data-step]")].map(node => node.dataset.step)',
          ),
          ["$source", "clip_plan", "$clips"],
        );
        assert.equal(
          await ev(
            'document.querySelectorAll("main svg path[marker-end]").length',
          ),
          2,
        );

        assert.equal(
          await ev(`!!document.querySelector('a[href="${processingPath}"]')`),
          false,
        );
        await inspect("$source");
        assert.ok(
          await ev(
            `!!${ready(panel("$source"))}.querySelector("#original-video-heading")`,
          ),
        );
        await capture("recording-preview", w);
        await inspect("$clips");
        assert.equal(
          await ev('document.querySelector("tbody th a").textContent'),
          "Clip 1",
        );
        assert.equal(
          await ev('document.querySelectorAll("thead th").length'),
          3,
        );
        await capture("recording-clips", w);
        await click(`a[href="${processingPath}"]`);
        await until(
          `location.pathname === ${JSON.stringify(processingPath)} && !!${ready(graph)}`,
        );
        assert.deepEqual(
          await ev(
            '[...document.querySelectorAll("button[data-step]")].map(node => node.dataset.step)',
          ),
          ["$input", "segment", "caption", "hand_pose"],
        );
        await inspect("$input");
        assert.ok(
          await ev(
            `!!${ready(panel("$input"))}.querySelector("#original-video-heading")`,
          ),
        );
        await capture("clip-preview", w);
        await inspect("segment");
        assert.match(
          await ev(`${ready(panel("segment"))}.innerText`),
          /Runs \(1\)/,
        );
        assert.ok(
          await ev(
            `${ready(panel("segment"))}.getBoundingClientRect().top >= ${ready(graph)}.getBoundingClientRect().bottom`,
          ),
        );
        await until('document.activeElement.dataset.stepDetails === "segment"');
        await capture("clip-step-details", w);
        await send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Escape",
          code: "Escape",
          windowsVirtualKeyCode: 27,
        });
        await until(
          `!${ready(panel("segment"))} && document.activeElement.dataset.step === "segment"`,
        );
        await send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: " ",
          code: "Space",
          windowsVirtualKeyCode: 32,
        });
        await send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: " ",
          code: "Space",
          windowsVirtualKeyCode: 32,
        });
        await until(`${ready(panel("segment"))} === document.activeElement`);

        await click(`a[href="${definitionPath}"]`);
        await until(
          `decodeURIComponent(location.pathname) === "/recipes/stub_local@1" && !!${ready(graph)}`,
        );
      }

      await open(reviewPath, '[data-testid="provenance"]');
      const stepPath = path + "&step=segment";
      await click(`[data-testid="provenance"] a[href="${stepPath}"]`);
      await until(
        `location.search.includes("step=segment") && !!${ready(panel("segment"))}`,
      );
      const recordedModel = await ev(
        `[...document.querySelectorAll('[data-step-details="segment"] dt')].find(dt => dt.textContent === "Recorded model")?.nextElementSibling.textContent`,
      );
      assert.ok(recordedModel && recordedModel !== "Not recorded");

      const activePath = recipePath(active.jobId);
      await open(activePath, graph);
      assert.match(
        await ev(
          'document.querySelector("button[data-step=segment]").innerText',
        ),
        /Running/,
      );
      assert.equal(
        await ev('!!document.querySelector("button[data-step=caption]")'),
        false,
      );
      seed(active.jobId);
      await open(activePath + "&step=segment", panel("segment"));
      assert.match(
        await ev(`${ready(panel("segment"))}.innerText`),
        /Failed[\s\S]*receipt_missing/,
      );
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
        await open(stepPath, panel("segment"));
        assert.match(
          await ev(
            'document.querySelector("[data-step-details=segment] details").textContent',
          ),
          /Recorded model[\s\S]*Not recorded/,
        );
        assert.doesNotMatch(
          await ev(
            'document.querySelector("[data-step-details=segment] details").textContent',
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
