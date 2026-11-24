import {
  floraCheckpointPins,
  requestSha256,
  type ModalRerunBinding,
} from "@stateaction/contracts";
import type { ModalClient } from "modal";
import {
  inspectModalVolumes,
  type ModalVolumeReads,
} from "./modal-model-volume.js";

export type ModalInspectionApi = Pick<
  ModalClient["cpClient"],
  "functionGet" | "functionGetSchedulingParams"
> &
  Partial<ModalVolumeReads>;
type Deployment = Pick<
  ModalRerunBinding,
  | "appName"
  | "environment"
  | "gpu"
  | "maxContainers"
  | "maxCpuMilli"
  | "maxMemoryMib"
  | "maxBilledSeconds"
  | "microUsdPerCpuSecond"
  | "microUsdPerGpuSecond"
>;
type FunctionGet = Awaited<ReturnType<ModalInspectionApi["functionGet"]>>;
type FunctionDefinition = NonNullable<FunctionGet["function"]>;
type FunctionVariant = NonNullable<
  FunctionDefinition["rankedFunctions"][number]["function"]
>;
type Resources = NonNullable<FunctionVariant["resources"]>;

// Modal list rates in microdollars per core, GiB and RTX PRO 6000 second.
// https://modal.com/pricing
const LIST_CPU = 13.1;
const LIST_MEMORY = 2.22;
const LIST_RTX_PRO_6000 = 842;
const NONPREEMPTIBLE_MULTIPLIER = 3;
// Enum values documented in Modal's control-plane schema.
const FUNCTION_TYPE_FUNCTION = 2;
const DEFINITION_TYPE_FILE = 2;

function hasAlternates(fn: FunctionDefinition | FunctionVariant) {
  return (
    fn.isClass ||
    fn.isMethod ||
    fn.isServer ||
    fn.isSessioned ||
    fn.webUrl ||
    fn.webhookConfig?.type ||
    fn.customDomainInfo?.length ||
    Object.keys(fn.methodDefinitions ?? {}).length ||
    fn.routingRegion ||
    fn.flashServiceLabel ||
    fn.flashServiceUrls?.length ||
    fn.workerId ||
    fn.ExperimentalGroupSize ||
    fn.ExperimentalFabricSize ||
    fn.ExperimentalCustomScaling ||
    fn.ExperimentalEnableGpuSnapshot ||
    Object.keys(fn.experimentalOptions ?? {}).length ||
    (fn.functionType && fn.functionType !== FUNCTION_TYPE_FUNCTION)
  );
}

function violatesBounds(
  fn: FunctionDefinition | FunctionVariant,
  maxContainers: number,
) {
  const scaling = fn.autoscalerSettings;
  return (
    (fn.concurrencyLimit ?? 0) > maxContainers ||
    (scaling?.maxContainers ?? 0) > maxContainers ||
    (fn.warmPoolSize ?? 0) !== 0 ||
    (fn.ExperimentalBufferContainers ?? 0) !== 0 ||
    (scaling?.minContainers ?? 0) !== 0 ||
    (scaling?.bufferContainers ?? 0) !== 0
  );
}

function resourcesMatch(resources: Resources, deployment: Deployment) {
  const gpu = deployment.gpu.toUpperCase();
  const gpuCount = resources.gpuConfig?.count ?? 0;
  const gpuType = resources.gpuConfig?.gpuType?.toUpperCase() ?? "";
  const disk = resources.ephemeralDiskMb ?? 0;
  const cpu = Math.max(resources.milliCpu, resources.milliCpuMax);
  // Modal adds a memory request of one MiB per 20 MiB of requested disk.
  const memory = Math.max(
    resources.memoryMb,
    resources.memoryMbMax,
    Math.ceil(disk / 20),
  );
  const rate = (cpu / 1000) * LIST_CPU + (memory / 1024) * LIST_MEMORY;
  if (
    !(resources.milliCpuMax > 0) ||
    !(resources.memoryMbMax > 0) ||
    !(cpu > 0 && cpu <= deployment.maxCpuMilli) ||
    !(memory > 0 && memory <= deployment.maxMemoryMib) ||
    disk < 0 ||
    resources.rdma ||
    resources.gpuConfig?.type ||
    (gpu === "NONE"
      ? gpuCount !== 0 ||
        gpuType !== "" ||
        deployment.microUsdPerGpuSecond !== 0
      : gpuCount !== 1 ||
        gpuType !== gpu ||
        gpu !== "RTX-PRO-6000" ||
        deployment.microUsdPerGpuSecond < LIST_RTX_PRO_6000)
  )
    return false;
  const multiplier = gpu === "NONE" ? NONPREEMPTIBLE_MULTIPLIER : 1;
  return deployment.microUsdPerCpuSecond >= Math.ceil(rate * multiplier);
}

/** Read the exact deployment definition and verify the effective billing envelope. */
export async function inspectModalDeployment(
  api: ModalInspectionApi,
  deployment: Deployment,
  objectTag: string,
  module?: string,
  checkpointPins = floraCheckpointPins,
) {
  const { appName, environment } = deployment;
  const {
    functionId,
    function: definition,
    handleMetadata,
  } = await api.functionGet({
    appName,
    objectTag,
    environmentName: environment,
    // The protobuf default omits version. Version-pinned calls require another Modal plan.
    appVersion: 0,
  });
  const { definitionId: providerDefinitionId, appId } = handleMetadata ?? {};
  if (
    !functionId ||
    !appId ||
    !definition?.moduleName ||
    definition.functionName !== objectTag ||
    definition.rankedFunctions.length !== 1 ||
    hasAlternates(definition) ||
    violatesBounds(definition, deployment.maxContainers) ||
    definition.schedule?.cron ||
    definition.schedule?.period ||
    definition.httpConfig?.port ||
    definition.httpConfig?.proxyRegions?.length ||
    definition.httpConfig?.liftAndShiftConfig ||
    handleMetadata?.webUrl ||
    handleMetadata?.isMethod ||
    handleMetadata?.useMethodName ||
    handleMetadata?.ExperimentalFlashUrls?.length ||
    Object.keys(handleMetadata?.methodHandleMetadata ?? {}).length ||
    (handleMetadata?.functionType &&
      handleMetadata.functionType !== FUNCTION_TYPE_FUNCTION) ||
    (handleMetadata?.functionName &&
      handleMetadata.functionName !== objectTag) ||
    (handleMetadata?.baseFunctionId &&
      handleMetadata.baseFunctionId !== functionId)
  )
    return undefined;

  const autoscaler = (await api.functionGetSchedulingParams({ functionId }))
    .autoscalerConfiguration;
  const schedule = autoscaler?.settings;
  const scaledownWindow = schedule?.scaledownWindow;
  if (
    !schedule?.maxContainers ||
    schedule.maxContainers > deployment.maxContainers ||
    (schedule.minContainers ?? 0) !== 0 ||
    (schedule.bufferContainers ?? 0) !== 0 ||
    scaledownWindow === undefined ||
    !Number.isSafeInteger(scaledownWindow) ||
    scaledownWindow < 0 ||
    // The SDK decodes an empty override message with undefined own fields.
    Object.values(autoscaler?.overrideSettings ?? {}).some(
      (value) => value !== undefined,
    ) ||
    Object.keys(autoscaler?.overrideEvents ?? {}).length
  )
    return undefined;

  const { rank, function: variant } = definition.rankedFunctions[0]!;
  const resources = variant?.resources;
  const placement = variant?.schedulerPlacement;
  const cpuOnly = deployment.gpu.toUpperCase() === "NONE";
  if (
    rank !== 0 ||
    !variant ||
    !resources ||
    variant.appName !== appName ||
    !variant.imageId ||
    !variant.timeoutSecs ||
    (variant.functionName && variant.functionName !== objectTag) ||
    (variant.definitionType &&
      variant.definitionType !== DEFINITION_TYPE_FILE) ||
    (cpuOnly ? !placement?.nonpreemptible : placement !== undefined) ||
    // The list rates above use default placement, without regional or instance pins.
    placement?.regions?.length ||
    placement?.InstanceTypes?.length ||
    placement?.Zone ||
    placement?.Lifecycle ||
    variant.cloudProvider ||
    variant.cloudProviderStr ||
    variant.proxyId ||
    variant.ptyInfo ||
    variant.ExperimentalTaskTemplatesEnabled ||
    variant.ExperimentalTaskTemplates?.length ||
    variant.i6pnEnabled ||
    variant.isBuilderFunction ||
    variant.isAutoSnapshot ||
    variant.isCheckpointingFunction ||
    variant.checkpointingEnabled ||
    variant.checkpoint ||
    variant.enableGpuSnapshot ||
    (variant.maxConcurrentInputs ?? 0) > 1 ||
    (variant.targetConcurrentInputs ?? 0) > 1 ||
    (variant.maxInputs ?? 0) > 1 ||
    variant.batchMaxSize ||
    variant.batchLingerMs ||
    variant.functionSerialized?.length ||
    variant.classSerialized?.length ||
    (variant.retryPolicy?.retries ?? 0) !== 0 ||
    hasAlternates(variant) ||
    violatesBounds(variant, deployment.maxContainers) ||
    !resourcesMatch(resources, deployment)
  )
    return undefined;

  const timeout = Math.max(variant.timeoutSecs, definition.timeoutSecs ?? 0);
  const startup =
    Math.max(
      variant.startupTimeoutSecs ?? 0,
      definition.startupTimeoutSecs ?? 0,
    ) || timeout;
  const idle = Math.max(
    scaledownWindow,
    definition.taskIdleTimeoutSecs ?? 0,
    variant.taskIdleTimeoutSecs ?? 0,
    definition.autoscalerSettings?.scaledownWindow ?? 0,
    variant.autoscalerSettings?.scaledownWindow ?? 0,
  );
  // Modal can slightly overrun the function timeout. Include startup and idle billing.
  if (timeout + startup + idle + 60 > deployment.maxBilledSeconds)
    return undefined;

  // An attached secret's values can rotate behind the same ID. Only a
  // provider-issued definition may carry attachments we cannot inspect.
  if (
    (!providerDefinitionId && variant.secretIds?.length) ||
    variant.sharedVolumeMounts?.length ||
    variant.cloudBucketMounts?.length ||
    variant.s3Mounts?.length
  )
    return undefined;
  const volumeMounts = await inspectModalVolumes(
    api,
    variant.volumeMounts ?? [],
    environment,
    module,
    checkpointPins,
  );
  if (!volumeMounts) return undefined;

  // Bind every field decoded by this SDK, including defaults, source dependencies
  // and the declared and effective autoscaler settings. Input-plane addresses
  // are transport metadata and can change behind the verified function ID.
  const {
    inputPlaneUrl: _url,
    inputPlaneRegion: _region,
    ...executionHandle
  } = handleMetadata ?? {};
  const definitionSha256 = requestSha256(
    JSON.parse(
      JSON.stringify(
        {
          appName,
          appId,
          environment,
          functionId,
          providerDefinitionId: providerDefinitionId || null,
          objectTag,
          definition,
          executionHandle,
          autoscaler,
          volumeMounts,
        },
        (_key, value: unknown) =>
          value instanceof Uint8Array ? [...value] : value,
      ),
    ),
  );
  return {
    functionId,
    definitionId:
      providerDefinitionId || `definition-sha256-${definitionSha256}`,
    definitionSha256,
  };
}
