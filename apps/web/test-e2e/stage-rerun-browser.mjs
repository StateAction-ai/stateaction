import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const command = promisify(execFile);

// The frozen stage-rerun API test supplies the persisted parent and child.
export async function checkStageRerunBrowser({
  stack,
  parent,
  childJobId,
  out,
}) {
  await mkdir(out, { recursive: true });
  const session = `sa142-${process.pid}`;
  const ab = async (...args) =>
    (
      await command("agent-browser", ["--session", session, ...args], {
        encoding: "utf8",
        timeout: 45_000,
      })
    ).stdout.trim();
  const evaluate = async (script) => JSON.parse(await ab("eval", script));
  const clipId = parent.clipId ?? parent.recordingId;
  const processing = `/recordings/${parent.recordingId}/clips/${clipId}/processing`;
  const evidence = [];
  try {
    await ab("open", `${stack.origin}/login`);
    await ab("wait", "input[name=email]");
    await ab("fill", "input[name=email]", stack.users.staff.email);
    await ab("fill", "input[name=password]", stack.password);
    await ab("click", "button[type=submit]");
    await ab("wait", "--fn", "location.pathname === '/recordings'");
    for (const width of [1280, 390]) {
      await ab("set", "viewport", String(width), "900");
      await ab("open", `${stack.origin}${processing}?run=${childJobId}`);
      await ab("wait", "main section h3");
      const earlier = `a[title="${parent.jobId}"]`;
      const child = `a[title="${childJobId}"]`;
      const sections =
        await evaluate(`[...document.querySelectorAll("main section:has(h3)")].map(section => ({
        title: section.querySelector("h2")?.textContent,
        containsChild: !!section.querySelector(${JSON.stringify(child)}),
        retainsEarlier: !!section.querySelector(${JSON.stringify(earlier)}),
        text: section.innerText,
      }))`);
      for (const name of ["Segmentation", "Captioning"]) {
        const stage = sections.find(({ title }) => title === name);
        assert.ok(stage?.retainsEarlier, name);
        assert.match(stage.text, /Used output from run|did not run again/);
      }
      const hand = sections.find(({ title }) => title === "Hand pose");
      assert.ok(hand?.containsChild);
      assert.match(hand.text, /Stage rerun/);
      assert.match(hand.text, /Parent/);
      assert.ok(
        await evaluate("document.documentElement.scrollWidth <= innerWidth"),
      );
      await ab("screenshot", "--full", join(out, `lineage-${width}.png`));
      evidence.push({ width, parentAndChildVisible: true, reusedStages: 2 });
    }
    await writeFile(
      join(out, "browser-evidence.json"),
      JSON.stringify(evidence, null, 2) + "\n",
    );
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    throw new Error("Seeded clip processing history did not render");
  } finally {
    await ab("close").catch(() => {});
  }
}
