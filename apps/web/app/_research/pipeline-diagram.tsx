"use client";

import { useState } from "react";
import styles from "./research.module.css";

export function PipelineDiagram() {
  const [run, setRun] = useState(0);

  return (
    <section
      id="pipeline"
      className={`${styles.inner} ${styles.workflow}`}
      aria-labelledby="workflow-title"
    >
      <div className={styles.workflowIntro}>
        <div>
          <h2 id="workflow-title">How the pipeline fits together</h2>
          <p>
            Every processing stage is fully customizable. Define your workflow
            in a Python recipe, change stage settings, or swap in your own
            models and processing modules.
          </p>
        </div>
        <button type="button" onClick={() => setRun((value) => value + 1)}>
          Play pipeline
        </button>
      </div>
      <ol key={run} className={styles.pipelineGraph} data-playing={run > 0}>
        <li className={`${styles.pipelineNode} ${styles.captureNode}`}>
          <strong>Capture</strong>
          <span>Android app or your own capture device</span>
        </li>
        <li className={`${styles.pipelineNode} ${styles.prepareNode}`}>
          <strong>Upload &amp; prepare</strong>
          <span>Store the recording and prepare it for clip processing</span>
        </li>
        <li className={styles.pipelineProcessing}>
          <div className={styles.pipelineGroupTitle}>Process each clip</div>
          <ol className={styles.pipelineBranch}>
            <li className={`${styles.pipelineNode} ${styles.segmentNode}`}>
              <strong>Segment actions</strong>
              <span>Find when each action starts and ends</span>
            </li>
            <li className={`${styles.pipelineNode} ${styles.captionNode}`}>
              <strong>Caption actions</strong>
              <span>Describe each detected segment</span>
            </li>
          </ol>
          <div className={`${styles.pipelineNode} ${styles.poseNode}`}>
            <strong>Estimate hand pose</strong>
            <span>
              Track hand joints in parallel with segmentation and captioning
            </span>
          </div>
        </li>
        <li className={`${styles.pipelineNode} ${styles.reviewNode}`}>
          <strong>Review in the browser</strong>
          <span>Video, action timeline, captions, and hand overlay</span>
        </li>
      </ol>
    </section>
  );
}
