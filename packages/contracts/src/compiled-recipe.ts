import { Ajv2020 } from "ajv/dist/2020.js";
import graphSchema from "../recipe/compiled-graph.v1.schema.json" with { type: "json" };
import receiptSchema from "../recipe/node-receipt.v2.schema.json" with { type: "json" };
import { requestSha256 } from "./canonical.js";
import type { CompiledGraph } from "./compiled-graph.generated.js";

const ajv = new Ajv2020({
  strict: true,
  allowUnionTypes: true,
  validateFormats: false,
});
const validateGraph = ajv.compile<CompiledGraph>(graphSchema);
const validateReceipt = ajv.compile<NodeReceipt>(receiptSchema);

export function readCompiledRecipe(
  value: unknown,
  ref: string,
  sha256: string,
  locks: ReadonlyMap<string, unknown>,
): CompiledGraph {
  if (!validateGraph(value))
    throw new TypeError(`Invalid compiled recipe schema for ${ref}`);
  const { recipeSha256, authoring: _authoring, ...body } = value;
  if (
    body.recipe !== ref ||
    recipeSha256 !== sha256 ||
    requestSha256(body) !== sha256
  ) {
    throw new TypeError(`Compiled recipe identity mismatch for ${ref}`);
  }
  for (const node of Object.values(value.nodes)) {
    const lock = locks.get(node.module);
    if (lock === undefined || requestSha256(lock) !== node.moduleLockSha256)
      throw new TypeError(
        `Compiled recipe module lock mismatch for ${node.module}`,
      );
  }
  return value;
}

export type NodeReceipt = {
  executionRef: string;
  outputs: Record<
    string,
    {
      kind: string;
      files: Record<
        string,
        { name: string; sizeBytes: number; sha256: string }
      >;
    }
  >;
  sourceSha256: string;
};

export function readNodeReceipt(value: unknown): NodeReceipt {
  if (!validateReceipt(value))
    throw new TypeError("Invalid recipe node receipt");
  return value;
}
