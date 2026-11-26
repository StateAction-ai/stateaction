import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { findChrome, launchChrome } from "./chrome.mjs";
import { SESSION, signIn } from "./harness.mjs";

export async function checkStageRerunBrowser({
  stack,
  parent,
  handRunId,
  captionRunId,
  out,
}) {
  await mkdir(out, { recursive: true });
  const binary = await findChrome();
  assert.ok(binary, "Chromium is required for the lineage browser check");
  const chrome = await launchChrome(binary);
  const send = (...args) => chrome.send(...args);
  const clipId = parent.clipId ?? parent.recordingId;
  const processing = `/recordings/${parent.recordingId}/clips/${clipId}/processing`;
  const evidence = [];
  const ev = async (expression) => {
    const { result, exceptionDetails } = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
    });
    assert.equal(exceptionDetails, undefined, expression);
    return result.value;
  };
  async function until(expression, label) {
    const deadline = Date.now() + 15_000;
    do {
      const result = await ev(expression);
      if (result) return result;
      await sleep(50);
    } while (Date.now() < deadline);
    assert.fail(label);
  }

  try {
    const staff = await signIn(stack, "staff");
    const cookie = await send("Network.setCookie", {
      name: SESSION,
      value: staff.cookies.get(SESSION),
      url: stack.origin,
      httpOnly: true,
    });
    assert.ok(cookie.success);
    for (const width of [1280, 390]) {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      const { errorText } = await send("Page.navigate", {
        url: stack.origin + processing,
      });
      assert.equal(errorText, undefined);
      for (const step of ["segment", "caption", "hand_pose"]) {
        const node = `document.querySelector('button[data-step="${step}"]')`;
        const panel = `document.querySelector('[data-step-details="${step}"]')`;
        await until(
          `!!${node} && Object.keys(${node}).some(key => key.startsWith("__reactProps$"))`,
          `${step} node hydrated at ${width}px`,
        );
        await ev(
          `${node}.scrollIntoView({ block: "center", inline: "center", behavior: "instant" })`,
        );
        const { x, y } = await until(
          `(() => {
            const button = ${node};
            const box = button.getBoundingClientRect();
            const x = box.x + box.width / 2;
            const y = box.y + box.height / 2;
            return button.contains(document.elementFromPoint(x, y)) && { x, y };
          })()`,
          `${step} node reachable after scrolling at ${width}px`,
        );
        for (const type of ["mousePressed", "mouseReleased"]) {
          await send("Input.dispatchMouseEvent", {
            type,
            x,
            y,
            button: "left",
            clickCount: 1,
          });
        }
        await until(
          `${panel} === document.activeElement`,
          `${step} panel focused at ${width}px`,
        );
        const sourceRunId = step === "hand_pose" ? handRunId : parent.jobId;
        const history = await ev(`(section => ({
          source: [...section.querySelectorAll("a")].some(link => new URL(link.href).searchParams.get("run") === "${sourceRunId}"),
          captionRun: [...section.querySelectorAll("a")].some(link => new URL(link.href).searchParams.get("run") === "${captionRunId}"),
          text: section.innerText,
        }))(${panel})`);
        assert.ok(history.source, step);
        if (step === "caption") {
          assert.ok(history.captionRun);
          assert.match(history.text, /Partially complete/);
          assert.match(history.text, /Failed captions: 2/);
          assert.match(history.text, /Parent run/);
        } else {
          assert.match(history.text, /Reused output from source run/);
        }
      }
      assert.ok(await ev("document.documentElement.scrollWidth <= innerWidth"));
      const { data } = await send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
      });
      await writeFile(
        join(out, `lineage-${width}.png`),
        Buffer.from(data, "base64"),
      );
      evidence.push({ width, parentAndChildVisible: true, reusedStages: 2 });
    }
    await writeFile(
      join(out, "browser-evidence.json"),
      JSON.stringify(evidence, null, 2) + "\n",
    );
  } finally {
    await chrome.close();
  }
}
