import assert from "node:assert/strict";
import test from "node:test";
import {
  HeadObjectCommand,
  ListPartsCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import {
  ProviderUploadGone,
  S3MultipartProvider,
} from "../src/transport/provider.js";

/** S3 client stub serving scripted responses and recording each command. */
function client(handler: (command: unknown) => unknown) {
  const sent: unknown[] = [];
  const stub = {
    send: async (command: unknown) => {
      sent.push(command);
      return handler(command);
    },
  } as unknown as S3Client;
  return { stub, sent };
}
const named = (name: string, status: number) =>
  Object.assign(new Error(name), {
    name,
    $metadata: { httpStatusCode: status },
  });

test("ListParts walks every page: 2,500 parts need three pages and nothing is dropped", async () => {
  const total = 2500;
  const { stub, sent } = client((command) => {
    assert.ok(command instanceof ListPartsCommand);
    const start = Number(command.input.PartNumberMarker ?? 0);
    const end = Math.min(start + 1000, total);
    return {
      Parts: Array.from({ length: end - start }, (_, i) => ({
        PartNumber: start + i + 1,
        ETag: `"etag-${start + i + 1}"`,
        Size: 5,
      })),
      IsTruncated: end < total,
      NextPartNumberMarker: String(end),
    };
  });
  const provider = new S3MultipartProvider(stub, stub, "b");
  const parts = await provider.listParts("k", "u", 1, total);
  assert.equal(sent.length, 3);
  assert.equal(parts.length, total);
  assert.deepEqual(
    parts.map((p) => p.partNumber),
    Array.from({ length: total }, (_, i) => i + 1),
  );
  assert.equal(
    parts[1999]!.etag,
    "etag-2000",
    "quotes stripped, nothing else changed",
  );
  assert.equal(parts[0]!.sizeBytes, 5n);
});

test("ListParts maps NoSuchUpload to ProviderUploadGone and keeps other failures", async () => {
  const gone = new S3MultipartProvider(
    client(() => {
      throw named("NoSuchUpload", 404);
    }).stub,
    client(() => null).stub,
    "b",
  );
  await assert.rejects(gone.listParts("k", "u", 1, 3), ProviderUploadGone);
  const down = new S3MultipartProvider(
    client(() => {
      throw named("InternalError", 500);
    }).stub,
    client(() => null).stub,
    "b",
  );
  await assert.rejects(down.listParts("k", "u", 1, 3), /InternalError/);
});

test("HEAD is null only for a missing key; abort of a gone upload is a no-op", async () => {
  const missing = new S3MultipartProvider(
    client((command) => {
      assert.ok(command instanceof HeadObjectCommand);
      throw named("NotFound", 404);
    }).stub,
    client(() => null).stub,
    "b",
  );
  assert.equal(await missing.headObject("k"), null);
  const broken = new S3MultipartProvider(
    client(() => {
      throw named("Forbidden", 403);
    }).stub,
    client(() => null).stub,
    "b",
  );
  await assert.rejects(broken.headObject("k"), /Forbidden/);
  const head = new S3MultipartProvider(
    client(() => ({ ContentLength: 123, ETag: '"abc-2"', PartsCount: 2 })).stub,
    client(() => null).stub,
    "b",
  );
  assert.deepEqual(await head.headObject("k"), {
    sizeBytes: 123n,
    etag: "abc-2",
    partsCount: 2,
  });
  const abort = new S3MultipartProvider(
    client(() => {
      throw named("NoSuchUpload", 404);
    }).stub,
    client(() => null).stub,
    "b",
  );
  await abort.abortUpload("k", "u");
});

function pagedParts(total: number, pageSize = 1000) {
  return client((command) => {
    assert.ok(command instanceof ListPartsCommand);
    const start = Number(command.input.PartNumberMarker ?? 0);
    const end = Math.min(start + pageSize, total);
    return {
      Parts: Array.from({ length: end - start }, (_, i) => ({
        PartNumber: start + i + 1,
        ETag: `"e${start + i + 1}"`,
        Size: 1,
      })),
      IsTruncated: end < total,
      NextPartNumberMarker: String(end),
    };
  });
}

test("ListParts page boundaries: 1,000 / 1,001 / 10,000 parts are all returned exactly", async () => {
  for (const [total, pages] of [
    [1000, 1],
    [1001, 2],
    [10_000, 10],
  ] as const) {
    const { stub, sent } = pagedParts(total);
    const parts = await new S3MultipartProvider(stub, stub, "b").listParts(
      "k",
      "u",
      1,
      total,
    );
    assert.equal(parts.length, total, `${total} parts`);
    assert.equal(sent.length, pages, `${total} pages`);
    assert.equal(parts.at(-1)!.partNumber, total);
  }
});

test("a listing that never ends is refused instead of trusted (more than 20 pages)", async () => {
  const { stub, sent } = client(() => ({
    Parts: [{ PartNumber: 1, ETag: '"e"', Size: 1 }],
    IsTruncated: true,
    NextPartNumberMarker: "1",
  }));
  await assert.rejects(
    new S3MultipartProvider(stub, stub, "b").listParts("k", "u", 1, 10_000),
    /did not terminate/,
  );
  assert.equal(sent.length, 20, "bounded, no unbounded retry");
});
