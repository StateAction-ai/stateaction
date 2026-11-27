import { ReviewPage } from "../../components/review/review-page";
import {
  captionStepList,
  handOf,
  shortLabel,
} from "../../lib/review/short-label";
import type { ReviewModel, VideoSource } from "../../lib/review/types";
import { demoHandPresence, demoSegments } from "./demo-segments";
import styles from "./research.module.css";

const dataset = "https://huggingface.co/datasets/FraunhoferIPK/IndEgo";
// The segment timestamps and hand detections were produced from this revision.
const datasetRevision = "c822468b5e0c9c42ebbf2939d3be936c2b203704";
const videoPath = "2_Inspection_Repair/mp4_480/User_15_410_0511_1_480.mp4";
const durationS = 29.6;
const source: VideoSource = {
  kind: "direct",
  url: `${dataset}/resolve/${datasetRevision}/${videoPath}`,
  range: { startS: 0, durationS },
};

function handLane(
  side: keyof typeof demoHandPresence,
): ReviewModel["lanes"]["left"] {
  return demoHandPresence[side].map(([startS, endS, state]) => ({
    startS,
    endS,
    state,
  }));
}

const cards: ReviewModel["cards"] = demoSegments.map(
  ([startS, endS, startFrameId, endFrameId, text], index) => ({
    index,
    segmentId: startFrameId,
    startS,
    endS,
    startFrameId,
    endFrameId,
    kind: "segment",
    caption: {
      state: "complete",
      text,
      label: shortLabel(text),
      hand: handOf(text),
      steps: captionStepList(text),
    },
    handsLR: { left: null, right: null, partial: false },
    derivedLocally: true,
  }),
);
const handCounts: ReviewModel["handCounts"] = {
  left: 0,
  right: 0,
  both: 0,
  none: 0,
};
for (const card of cards) {
  if (card.caption.state === "complete") handCounts[card.caption.hand]++;
}

const model: ReviewModel = {
  durationS,
  originNs: "0",
  cards,
  lanes: { left: handLane("left"), right: handLane("right") },
  presence: "available",
  presenceNote: null,
  derivedRule: null,
  failures: [],
  handCounts,
  clips: [],
  provenance: [],
  summary: {
    segments: demoSegments.length,
    failedWindows: 0,
    failedCaptions: 0,
  },
};

export function ResearchClip() {
  return (
    <figure className={styles.figure} aria-label="IndEgo clip review demo">
      <figcaption>
        <span>Clip review</span>
        <span>IndEgo excerpt</span>
      </figcaption>
      <div className={styles.clipPlayer}>
        <ReviewPage
          embedded
          model={model}
          title="IndEgo inspection and repair excerpt"
          source={source}
          suggested={false}
          backHref="/"
          backLabel="Research"
          previousHref={null}
          nextHref={null}
          posterPath={null}
          handFramesPath={null}
          startAt={null}
          initialSegmentId={null}
        />
      </div>
      <p className={styles.clipAttribution}>
        <a href={`${dataset}/blob/${datasetRevision}/${videoPath}`}>
          IndEgo recording
        </a>{" "}
        by Vivek Chavan, Yasmina Imgrund, Tung Dao, Sanwantri Bai, Bosong Wang,
        Ze Lu, Oliver Heimann, and Jörg Krüger (2025),{" "}
        <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>.
        The player shows the first 29.6 seconds with StateAction segmentation
        and model captions. Hand indicators reflect model detections.
      </p>
    </figure>
  );
}
