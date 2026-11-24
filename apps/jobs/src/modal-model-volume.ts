import { floraCheckpointPins, sha256Hex } from "@stateaction/contracts";
import type { ModalClient } from "modal";

export type ModalVolumeReads = Pick<
  ModalClient["cpClient"],
  "volumeList" | "volumeGetFile2"
>;
type ProviderVolumeMount = NonNullable<
  Awaited<ReturnType<ModalClient["cpClient"]["functionGet"]>>["function"]
>["rankedFunctions"][number]["function"];
type VolumeMount = NonNullable<ProviderVolumeMount>["volumeMounts"][number];

const MAX_MANIFEST_BYTES = 64 * 1024;
const FLORA_MODULE = /^flora_(captioner|tempseg)_(?:vllm_fp8|hf)@1$/;

/** Resolve and read only the released FLORA manifest on the exact mounted Volume. */
export async function inspectModalVolumes(
  api: Partial<ModalVolumeReads>,
  volumes: VolumeMount[],
  environment: string,
  module: string | undefined,
  pins: typeof floraCheckpointPins,
) {
  const model = module
    ? (FLORA_MODULE.exec(module)?.[1] as "captioner" | "tempseg" | undefined)
    : undefined;
  if (!model) return volumes.length === 0 ? [] : undefined;
  const pin = pins.checkpoints[model];
  const mount = volumes[0];
  if (
    volumes.length !== 1 ||
    !mount ||
    !/^vo-[A-Za-z0-9]+$/.test(mount.volumeId) ||
    mount.mountPath !== "/models" ||
    !mount.readOnly ||
    typeof mount.allowBackgroundCommits !== "boolean" ||
    mount.subPath ||
    !api.volumeList ||
    !api.volumeGetFile2
  )
    return undefined;

  const listing = await api.volumeList({
    environmentName: environment,
    pagination: undefined,
  });
  const volume = listing.items.find((row) => row.volumeId === mount.volumeId);
  if (
    (listing.environmentName && listing.environmentName !== environment) ||
    volume?.metadata?.name !== pins.volumeName ||
    volume.metadata.version !== pins.volumeVersion
  )
    return undefined;

  const path = `flora/${pin.checkpointId}/MANIFEST.json`;
  const descriptor = await api.volumeGetFile2({
    volumeId: mount.volumeId,
    path,
    start: 0,
    len: 0,
    clientPadsBlocks: false,
  });
  if (
    !Number.isSafeInteger(descriptor.size) ||
    descriptor.size < 1 ||
    descriptor.size > MAX_MANIFEST_BYTES ||
    descriptor.start !== 0 ||
    descriptor.len !== descriptor.size ||
    descriptor.getUrls.length !== 1
  )
    return undefined;
  const url = new URL(descriptor.getUrls[0]!);
  if (url.protocol !== "https:" || url.username || url.password)
    return undefined;
  const bytes = await readManifest(url, descriptor.size);
  if (!bytes || sha256Hex(bytes) !== pin.manifestSha256) return undefined;

  return [
    {
      volumeId: mount.volumeId,
      name: volume.metadata.name,
      environment,
      version: Number(volume.metadata.version),
      mountPath: mount.mountPath,
      subPath: mount.subPath ?? "",
      readOnly: mount.readOnly,
      allowBackgroundCommits: mount.allowBackgroundCommits,
      manifestPath: path,
      manifestSha256: pin.manifestSha256,
      modelRevision: pin.modelRevision,
    },
  ];
}

async function readManifest(url: URL, size: number) {
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok || !response.body) return undefined;
  const reader = response.body.getReader();
  const bytes = new Uint8Array(size);
  let offset = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return offset === size ? bytes : undefined;
      if (offset + chunk.value.byteLength > size) return undefined;
      bytes.set(chunk.value, offset);
      offset += chunk.value.byteLength;
    }
  } finally {
    await reader.cancel();
  }
}
