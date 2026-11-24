import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const command = promisify(execFile);

export async function checkStageRerunBrowser({
  stack,
  parent,
  childJobId,
  out,
}) {
  mkdirSync(out, { recursive: true });
  const session = `sa142-${process.pid}`;
  let operation = "";
  const ab = async (...args) => {
    operation = args[0] === "wait" ? args.join(" ") : args[0];
    const { stdout } = await command(
      "agent-browser",
      ["--session", session, ...args],
      {
        encoding: "utf8",
        timeout: 45_000,
      },
    );
    return stdout.trim();
  };
  const evaluate = async (script) => JSON.parse(await ab("eval", script));
  const clickInView = async (locator, label) => {
    const clicked = await evaluate(`(() => {
      const button = ${locator};
      if (!button || button.disabled) return false;
      button.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const box = button.getBoundingClientRect();
      const x = Math.round(box.x + box.width / 2);
      const y = Math.round(box.y + box.height / 2);
      if (!button.contains(document.elementFromPoint(x, y))) return false;
      button.click();
      return true;
    })()`);
    assert.ok(clicked, `${label} must be reachable at its displayed position`);
  };
  const clickDialog = (label) =>
    clickInView(
      `[...document.querySelectorAll('dialog[open] button')].find((node) => node.textContent.trim() === ${JSON.stringify(label)})`,
      label,
    );
  const capture = [];
  try {
    await ab("open", `${stack.origin}/login`);
    await ab("wait", "input[name=email]");
    await ab("fill", "input[name=email]", stack.users.staff.email);
    await ab("fill", "input[name=password]", stack.password);
    await ab("click", "button[type=submit]");
    await ab("wait", "--fn", "location.pathname === '/pipeline'");
    for (const width of [1280, 390]) {
      await ab("set", "viewport", String(width), "900");
      const base = `${stack.origin}/pipeline/${parent.recordingId}`;
      await ab("open", `${base}?run=${parent.jobId}`);
      await ab("wait", '[data-stage="hand_pose"]');
      await ab("wait", "--load", "networkidle");
      for (const [index, label] of [
        "Re-run this stage",
        "Re-run from here",
      ].entries()) {
        const selector = '[data-stage="hand_pose"] button';
        assert.equal(
          await evaluate(
            `document.querySelectorAll(${JSON.stringify(selector)})[${index}]?.textContent.trim()`,
          ),
          label,
        );
        await clickInView(
          `document.querySelectorAll(${JSON.stringify(selector)})[${index}]`,
          label,
        );
        await ab(
          "wait",
          "--fn",
          "Boolean(document.querySelector('dialog[open] [data-testid=rerun-plan]'))",
        );
        const preview = await evaluate(
          "document.querySelector('dialog[open]').innerText",
        );
        assert.match(preview, /hand_pose_cpu_v1@1/);
        assert.match(preview, /Segment|segment/);
        assert.match(preview, /Caption|caption/);
        assert.match(preview, /\$0\.00/);
        if (label === "Re-run this stage") {
          await ab("screenshot", join(out, `confirm-${width}.png`));
          const rejectOnce = `(() => {
            const send = window.fetch;
            window.fetch = (url, init) => {
              if (typeof url === "string" && url.endsWith("/stage-reruns") && init?.method === "POST") {
                window.fetch = send;
                const request = JSON.parse(init.body);
                return send(url, { ...init, body: JSON.stringify({ ...request, expectedPlanSha256: "0".repeat(64) }) });
              }
              return send(url, init);
            };
          })()`;
          await ab("eval", rejectOnce);
          await ab(
            "fill",
            'dialog[open] input[maxlength="512"]',
            "Exercise rejected confirmation",
          );
          await clickDialog("Confirm rerun");
          await ab(
            "wait",
            "--text",
            "The plan changed. Preview it again before confirming.",
          );
          await clickDialog("Preview plan");
          await ab(
            "wait",
            "--fn",
            "Boolean(document.querySelector('dialog[open] [data-testid=rerun-plan]'))",
          );
        }
        await ab("press", "Escape");
      }
      await ab("open", `${base}?run=${childJobId}`);
      await ab("wait", '[data-testid="rerun-lineage"]');
      const lineage = await evaluate(
        "document.querySelector('[data-testid=rerun-lineage]').innerText",
      );
      assert.match(lineage, new RegExp(parent.jobId.slice(0, 8)));
      assert.match(lineage, /Reused Segmentation, Captioning/);
      assert.equal(
        await evaluate(
          `[...document.querySelectorAll('[data-stage]')].filter((row) =>
          row.querySelector('summary')?.textContent === 'Original receipt').length`,
        ),
        2,
      );
      assert.equal(
        await evaluate("document.documentElement.scrollWidth <= innerWidth"),
        true,
      );
      const row = (jobId) =>
        `document.querySelector('[data-run-id="${jobId}"]')`;
      await clickInView(
        `${row(parent.jobId)}?.querySelector('button')`,
        "Select parent result",
      );
      await ab(
        "wait",
        "--fn",
        `${row(parent.jobId)}?.innerText.includes('Selected')`,
      );
      await ab("eval", "window.scrollTo(0, 0)");
      await ab("screenshot", "--full", join(out, `lineage-${width}.png`));
      await clickInView(
        `${row(childJobId)}?.querySelector('button')`,
        "Restore selected rerun",
      );
      await ab(
        "wait",
        "--fn",
        `${row(childJobId)}?.innerText.includes('Selected')`,
      );
      capture.push({
        width,
        bothActions: true,
        definitiveRejectionReplanned: true,
        lineage: true,
        selectedResultSwitch: true,
        originalReceipts: 2,
      });
    }
    writeFileSync(
      join(out, "browser-evidence.json"),
      JSON.stringify(capture, null, 2) + "\n",
    );
  } catch (error) {
    // Browser CLI errors can include the subprocess command line. Avoid printing fixture cookies.
    if (error instanceof assert.AssertionError) throw error;
    const failedOperation = operation;
    let pathname = "";
    try {
      pathname = await evaluate("location.pathname");
    } catch {}
    let dialogFeedback = "";
    try {
      dialogFeedback = await evaluate(
        "document.querySelector('dialog[open] [role=alert]')?.textContent ?? (document.querySelector('dialog[open]') ? 'dialog open' : 'dialog closed')",
      );
    } catch {}
    throw new Error(
      `Seeded rerun browser check failed during ${failedOperation} at ${pathname} (${dialogFeedback})`,
    );
  } finally {
    try {
      await ab("close");
    } catch {}
  }
}
