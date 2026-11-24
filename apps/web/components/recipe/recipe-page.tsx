import Link from "next/link";
import {
  ArrowDown,
  ArrowRight,
  CheckCircle2,
  CircleDashed,
  CircleHelp,
  CircleX,
} from "lucide-react";
import {
  moduleManifestEntry,
  requestSha256,
  type DagRunNode,
  type Producer,
  type RecipeV1,
  type Stage,
} from "@stateaction/contracts";
import {
  formatDuration,
  nodeDurationSeconds,
  recordingTitle,
  buildRunStages,
  stageReason,
  type RunStageView,
  type RecipeVisualization,
} from "@stateaction/server/pipeline";
import {
  failedStageNote,
  PIPELINE_STATUS_LABEL,
  shortRecordingId,
} from "@stateaction/server/pipeline-model";
import { RECIPE_STAGES, recipeHref } from "../../lib/recipe-view";
import { cn } from "../../lib/utils";
import { Card, CardBody, CardHeader } from "../ui/card";
import { Spinner } from "../ui/spinner";

const missing = "Not recorded";
const link =
  "rounded text-brand underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand";
const inputText: Record<Stage, string> = {
  segment: "Source recording",
  caption: "Source recording + segments.json",
  hand_pose: "Source recording + available segments and captions",
};
const descriptions: Record<Stage, string> = {
  segment: "Finds where each action starts and ends.",
  caption: "Uses each action span and the video to describe what happened.",
  hand_pose:
    "Tracks hand landmarks and seals the available results for review.",
};
const plannedOutput: Record<Stage, string> = {
  segment: "segments.json",
  caption: "captions.json",
  hand_pose: "Review video, hand data and clip frame maps",
};

function StageStatus({
  stage,
}: {
  stage: Pick<RunStageView, "state" | "stateLabel" | "displayState">;
}) {
  const state = stage.displayState;
  const active = state === "running" || state === "submitting";
  const Icon = active
    ? Spinner
    : state === "succeeded"
      ? CheckCircle2
      : state === "failed" || state === "cancelled"
        ? CircleX
        : state === "submit_unknown" || state === "needs_attention"
          ? CircleHelp
          : CircleDashed;
  return (
    <span
      data-state={stage.state}
      data-display-state={state}
      className={cn(
        "inline-flex w-fit items-center gap-1.5 rounded-md bg-field px-2 py-1 text-xs font-semibold text-muted",
        active && "bg-brand-soft text-brand-ink",
        state === "succeeded" && "bg-[#e9f6ef] text-good",
        state === "failed" && "bg-danger-soft text-danger",
        (state === "submit_unknown" || state === "needs_attention") &&
          "bg-[#fff4de] text-[#8a5a00]",
      )}
    >
      <Icon aria-hidden="true" size={15} />
      {stage.stateLabel}
    </span>
  );
}

function Facts({
  entries,
  compact,
}: {
  entries: [string, string | number][];
  compact?: boolean;
}) {
  return (
    <dl
      className={cn(
        "m-0 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2",
        compact && "grid-cols-2",
      )}
    >
      {entries.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="text-xs font-medium text-muted">{label}</dt>
          <dd className="m-0 mt-0.5 text-sm font-semibold break-words">
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Parameters({
  values,
}: {
  values: Record<string, unknown> | undefined;
}) {
  if (!values) return <p className="m-0 text-sm text-muted">{missing}</p>;
  if (Object.keys(values).length === 0)
    return <p className="m-0 text-sm text-muted">None</p>;
  return (
    <pre className="m-0 rounded-md border border-line bg-field p-3 text-xs break-words whitespace-pre-wrap">
      {JSON.stringify(values, null, 2)}
    </pre>
  );
}

function StageDetails({
  spec,
  node,
  producer: result,
  unknownReason,
  view,
  title,
}: {
  spec: RecipeV1["stages"][number];
  node: DagRunNode | undefined;
  producer: Producer | "unavailable" | undefined;
  unknownReason: string | undefined;
  view: RunStageView | undefined;
  title: string;
}) {
  const producer = result === "unavailable" ? undefined : result;
  const module = moduleManifestEntry(spec.module);
  const code =
    node?.state === "submit_unknown" ? unknownReason : node?.errorCode;
  const reason = code
    ? (stageReason(code) ?? "Recorded reason code")
    : "Reason not recorded";
  const showReason =
    node &&
    ["failed", "not_run", "cancelled", "submit_unknown"].includes(node.state) &&
    (spec.enabled || code !== "stage_disabled");
  const duration = node ? nodeDurationSeconds(node) : null;
  return (
    <Card
      id={`stage-${spec.stage}`}
      tabIndex={-1}
      className="min-w-0 scroll-mt-4 self-start"
    >
      <CardHeader className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="m-0 font-bold">{title}</h3>
          <p className="m-0 mt-0.5 font-mono text-xs break-all text-muted">
            {spec.module}
          </p>
        </div>
        {view ? <StageStatus stage={view} /> : null}
      </CardHeader>
      <CardBody className="grid gap-4">
        {!spec.enabled ? (
          <p className="m-0 text-sm font-semibold text-muted">
            Disabled in this recipe
          </p>
        ) : null}
        {showReason ? (
          <p className="m-0 rounded-md border border-line bg-field p-2 text-sm break-words">
            {reason}
            {code ? <code className="ml-2 text-xs">{code}</code> : null}
          </p>
        ) : null}
        <Facts
          compact
          entries={[
            ["Resource class", spec.resources.gpu === "none" ? "CPU" : "GPU"],
            [
              "GPU requested",
              spec.resources.gpu === "none" ? "None (CPU)" : spec.resources.gpu,
            ],
            ["Time budget", formatDuration(spec.resources.budgetSeconds)],
            ["Retries", spec.resources.retries],
            ...(node
              ? ([
                  ["GPU observed", node.gpu.observedType ?? missing],
                  [
                    "Duration",
                    duration === null ? missing : formatDuration(duration),
                  ],
                  [
                    "Estimated cost",
                    node.estimatedCostUsd === null
                      ? missing
                      : `$${node.estimatedCostUsd}`,
                  ],
                ] satisfies [string, string][])
              : []),
          ]}
        />
        <details className="border-t border-line pt-3">
          <summary className={`cursor-pointer text-sm font-semibold ${link}`}>
            Configuration and provenance
          </summary>
          <div className="mt-4 grid gap-4">
            <Facts
              entries={[
                [
                  "Module license (declared)",
                  module
                    ? `${module.license.id} · ${module.license.commercialUse ? "commercial use allowed" : "non-commercial use"}`
                    : missing,
                ],
                ["Model (declared)", module?.provenance.modelName ?? missing],
                [
                  "Model revision (declared)",
                  module?.provenance.modelRevision ?? missing,
                ],
                ["Container limit", spec.resources.maxContainers],
                ["Configured parameters hash", requestSha256(spec.params)],
              ]}
            />
            <div>
              <h4 className="m-0 mb-1 text-xs font-semibold text-muted">
                Configured parameters
              </h4>
              <Parameters values={spec.params} />
            </div>
            {node ? (
              <>
                {result === "unavailable" ? (
                  <p className="m-0 text-sm text-muted">
                    Recorded provenance is currently unavailable.
                  </p>
                ) : null}
                <Facts
                  entries={[
                    ["Started (UTC)", node.startedAt ?? missing],
                    ["Finished (UTC)", node.finishedAt ?? missing],
                    ["Execution reference", node.callId ?? missing],
                    ["Stage receipt hash", node.receiptSha256 ?? missing],
                    ["Stage cost cap", missing],
                    ["Model (recorded)", producer?.model_name ?? missing],
                    [
                      "Model revision (recorded)",
                      producer?.model_revision ?? missing,
                    ],
                    ["Weights hash", producer?.weights_sha256 ?? missing],
                    ["Prompt text (recorded)", missing],
                    ["Prompt hash", producer?.prompt_sha256 ?? missing],
                    [
                      "Parameters hash (recorded)",
                      producer?.params_sha256 ?? missing,
                    ],
                    [
                      "Engine",
                      producer
                        ? `${producer.engine.name} ${producer.engine.version}`
                        : missing,
                    ],
                    ["Quantization", producer?.quant?.method ?? missing],
                    [
                      "Checkpoint manifest hash",
                      producer?.quant?.checkpoint_manifest_sha256 ?? missing,
                    ],
                  ]}
                />
                <div>
                  <h4 className="m-0 mb-1 text-xs font-semibold text-muted">
                    Decoding parameters (recorded)
                  </h4>
                  <Parameters values={producer?.decoding_params} />
                </div>
                <div>
                  <h4 className="m-0 mb-1 text-xs font-semibold text-muted">
                    Output counts (recorded)
                  </h4>
                  {Object.keys(node.counts).length ? (
                    <Facts
                      entries={Object.entries(node.counts).map(
                        ([key, value]) => [key.replaceAll("_", " "), value],
                      )}
                    />
                  ) : (
                    <p className="m-0 text-sm text-muted">{missing}</p>
                  )}
                </div>
              </>
            ) : null}
          </div>
        </details>
      </CardBody>
    </Card>
  );
}

function FlowStage({
  spec,
  view,
  input,
  title = RECIPE_STAGES[spec.stage],
  description = descriptions[spec.stage],
}: {
  spec: RecipeV1["stages"][number];
  view: RunStageView | undefined;
  input: string;
  title?: string;
  description?: string;
}) {
  return (
    <div className="grid min-w-0 grid-rows-[auto_1fr]">
      <div className="flex min-h-12 items-center gap-2 px-2 py-2 text-xs text-muted">
        <ArrowDown
          aria-hidden="true"
          size={16}
          className="shrink-0 text-brand"
        />
        {input}
      </div>
      <div
        className={cn(
          "grid content-start gap-2 rounded-lg border border-line bg-paper p-3",
          !spec.enabled && "border-dashed bg-field",
        )}
      >
        <a
          href={`#stage-${spec.stage}`}
          className={`text-sm font-bold ${link}`}
        >
          {title}
        </a>
        {view ? <StageStatus stage={view} /> : null}
        {!spec.enabled ? (
          <span className="text-xs font-semibold text-muted">
            Disabled in recipe
          </span>
        ) : null}
        <p className="m-0 text-xs text-muted">{description}</p>
        <span className="mt-1 border-t border-line pt-2 text-xs font-semibold break-words">
          {spec.enabled ? "Expected output" : "Output if enabled"} ·{" "}
          {plannedOutput[spec.stage]}
        </span>
      </div>
    </div>
  );
}

export function RecipePage({
  jobId,
  recipe,
  recipeSha256,
  recordingId,
  startedAt,
  run,
  acceptedCounts,
  topology,
  closure,
  producers,
  unknownReasons,
}: RecipeVisualization & { jobId: string }) {
  const byStage = new Map(run?.stages.map((node) => [node.stage, node]));
  const views = run ? buildRunStages(run, undefined, {}, acceptedCounts) : [];
  const stageViews = new Map(views.map((stage) => [stage.stage, stage]));
  const failedStages = views
    .filter(
      (stage) =>
        stage.displayState === "failed" ||
        stage.displayState === "needs_attention",
    )
    .map((stage) => stage.stage);
  const stageNote = failedStageNote(failedStages);
  const serial = topology === "serial";
  const stages = serial ? recipe.stages : recipe.stages.slice(0, 2);
  const hand = recipe.stages[2];
  return (
    <div className="mx-auto grid w-full min-w-0 max-w-6xl gap-6">
      <header>
        <Link className={`text-sm ${link}`} href={`/pipeline/${recordingId}`}>
          Recording in Pipeline
        </Link>
        <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="m-0 text-sm text-muted">
              {recordingTitle(new Date(startedAt))} ·{" "}
              {shortRecordingId(recordingId)}
            </p>
            <h1 className="m-0 mt-1 text-3xl font-bold tracking-tight break-all sm:text-4xl">
              {recipe.recipeId}
            </h1>
          </div>
          <nav
            aria-label="Recipe view"
            className="flex flex-wrap gap-3 text-sm"
          >
            <Link
              className={cn(link, run && "font-bold")}
              aria-current={run ? "page" : undefined}
              href={recipeHref(recipe.recipeId, jobId)}
            >
              Job run
            </Link>
            <Link
              className={cn(link, !run && "font-bold")}
              aria-current={run ? undefined : "page"}
              href={recipeHref(recipe.recipeId, jobId, { recipeOnly: true })}
            >
              Recipe only
            </Link>
          </nav>
        </div>
      </header>

      <Card data-testid="recipe-summary">
        <CardBody>
          <Facts
            compact
            entries={[
              ...(run
                ? ([
                    [
                      "Job status",
                      run.jobState === "submit_unknown"
                        ? "Start unconfirmed"
                        : run.jobState === "succeeded"
                          ? PIPELINE_STATUS_LABEL[
                              stageNote ? "needs_attention" : "completed"
                            ]
                          : run.jobState.charAt(0).toUpperCase() +
                            run.jobState.slice(1).replaceAll("_", " "),
                    ],
                    [
                      "Estimated job cost",
                      run.estimatedCostUsd === null
                        ? missing
                        : `$${run.estimatedCostUsd}`,
                    ],
                  ] satisfies [string, string][])
                : []),
              ["Job cost cap", `$${recipe.maxJobCostUsd}`],
            ]}
          />
          <details className="mt-3">
            <summary
              className={`w-fit cursor-pointer text-xs font-semibold ${link}`}
            >
              Recipe hash
            </summary>
            <p className="m-0 mt-2 font-mono text-xs break-all text-muted">
              {recipeSha256}
            </p>
          </details>
          {run?.jobState === "succeeded" && stageNote ? (
            <p className="m-0 mt-3 text-sm text-muted">
              Sealing succeeded. {stageNote}.
            </p>
          ) : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="m-0 text-lg font-bold" id="recipe-flow">
            Pipeline data flow
          </h2>
          <p className="m-0 mt-1 text-sm text-muted">
            {serial
              ? "This job tracks hands and seals its results after segmentation and captioning."
              : topology === "parallel"
                ? "Hand tracking runs alongside the action annotation path. Sealing waits for both paths."
                : "The current recipe flow has two paths. This job’s execution plan is not recorded yet."}
          </p>
        </CardHeader>
        <CardBody>
          <figure aria-labelledby="recipe-flow" className="m-0">
            <div className="rounded-lg border border-brand/20 bg-brand-soft px-4 py-3 text-brand-ink">
              <strong className="text-sm">Source recording · MCAP</strong>
              <p className="m-0 text-xs">
                Original video frames and timestamps feed each stage.
              </p>
            </div>
            <div
              className={cn(
                !serial && "mt-4 grid gap-3 md:grid-cols-[2fr_1fr]",
              )}
            >
              <div
                className={cn(
                  !serial &&
                    "min-w-0 rounded-lg border border-line bg-field p-3",
                )}
              >
                {!serial ? (
                  <h3 className="m-0 text-sm font-bold">Action annotations</h3>
                ) : null}
                <ol
                  role="list"
                  className={cn(
                    "m-0 grid list-none gap-x-6 p-0",
                    serial ? "md:grid-cols-3" : "md:grid-cols-2",
                  )}
                >
                  {stages.map((spec, index) => (
                    <li key={spec.stage} className="relative grid min-w-0">
                      <FlowStage
                        spec={spec}
                        view={stageViews.get(spec.stage)}
                        input={inputText[spec.stage]}
                      />
                      {index < stages.length - 1 ? (
                        <ArrowRight
                          aria-hidden="true"
                          size={18}
                          className="absolute -right-[21px] top-2/3 hidden text-brand md:block"
                        />
                      ) : null}
                    </li>
                  ))}
                </ol>
              </div>
              {!serial ? (
                <div className="grid min-w-0 rounded-lg border border-line bg-field p-3">
                  <h3 className="m-0 text-sm font-bold">CPU unit</h3>
                  <FlowStage
                    spec={hand}
                    view={stageViews.get("hand_pose")}
                    input="Source recording"
                    title="Track hand pose"
                    description="Tracks hand landmarks and prepares clips from the original frames."
                  />
                </div>
              ) : null}
            </div>
            {!serial ? (
              <div className="mt-3">
                <div className="grid gap-1 text-xs text-muted sm:grid-cols-2">
                  <span className="flex items-center gap-2">
                    <ArrowDown
                      aria-hidden="true"
                      size={16}
                      className="shrink-0 text-brand"
                    />
                    segments.json and captions.json when available
                  </span>
                  <span className="flex items-center gap-2">
                    <ArrowDown
                      aria-hidden="true"
                      size={16}
                      className="shrink-0 text-brand"
                    />
                    Hand data, clips and clip frame maps
                  </span>
                </div>
                <div className="mt-2 rounded-lg border border-line bg-paper p-3">
                  <h3 className="m-0 text-sm font-bold">Seal results</h3>
                  <p className="m-0 mt-1 text-xs text-muted">
                    The controller closes the output inventory after both paths
                    settle.
                  </p>
                  {run ? (
                    <p className="m-0 mt-2 text-xs font-semibold">
                      {closure
                        ? `Outputs closed at ${closure.closedAt} · Declared outcome: ${closure.outcome}`
                        : "Output closure not recorded"}
                    </p>
                  ) : null}
                </div>
              </div>
            ) : null}
            <figcaption className="mt-3 space-y-1 text-xs text-muted">
              <p className="m-0">
                Segmentation and captioning each prepare an MP4 and frame map
                from the source before running their model.
              </p>
              <p className="m-0">
                Shared video proxy · {missing}. Separate preparation and sealing
                timings · {missing}.
              </p>
            </figcaption>
          </figure>
        </CardBody>
      </Card>

      <section
        aria-labelledby="recipe-details"
        className="grid gap-3 xl:grid-cols-3"
      >
        <h2 className="m-0 text-lg font-bold xl:col-span-3" id="recipe-details">
          Stage details
        </h2>
        {recipe.stages.map((spec) => (
          <StageDetails
            key={spec.stage}
            spec={spec}
            node={byStage.get(spec.stage)}
            producer={producers[spec.stage]}
            unknownReason={unknownReasons[spec.stage]}
            view={stageViews.get(spec.stage)}
            title={
              spec.stage === "hand_pose" && !serial
                ? "Track hand pose"
                : RECIPE_STAGES[spec.stage]
            }
          />
        ))}
      </section>

      <Card>
        <CardBody>
          <details>
            <summary className={`cursor-pointer text-sm font-bold ${link}`}>
              Glossary
            </summary>
            <div className="mt-3">
              <Facts
                entries={[
                  ["Module", "A versioned processing step."],
                  [
                    "Frame map",
                    "Connects a video frame to its original frame ID and timestamp.",
                  ],
                  [
                    "Seal",
                    "Collects and verifies outputs so the recording can be reviewed.",
                  ],
                  [
                    "Hash",
                    "A fingerprint for an exact set of bytes or settings.",
                  ],
                  [
                    "Start unconfirmed",
                    "The system could not confirm whether the executor started.",
                  ],
                  [
                    "Not run",
                    "The stage never started. Its reason appears in Stage details.",
                  ],
                ]}
              />
            </div>
          </details>
        </CardBody>
      </Card>
    </div>
  );
}
