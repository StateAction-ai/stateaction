import assert from "node:assert/strict";
import test from "node:test";
import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  UploadPartCopyCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { copyPartBytes, s3RerunCopy } from "../src/jobs/stage-rerun-storage.js";

test("multipart copy resumes from saved parts and resolves a lost completion acknowledgement", async () => {
  const objects = {
    source: "existing/video.mp4",
    target: "child/video.mp4",
    size: copyPartBytes + 100,
  };
  let completed = false;
  let completionCalls = 0;
  const ranges: string[] = [];
  const provider = {
    async send(command: unknown, options: { abortSignal: AbortSignal }) {
      assert.ok(options.abortSignal);
      if (command instanceof CreateMultipartUploadCommand)
        return { UploadId: "fixture-upload" };
      if (command instanceof UploadPartCopyCommand) {
        assert.equal(command.input.UploadId, "fixture-upload");
        assert.equal(command.input.CopySource, "fixture/existing/video.mp4");
        ranges.push(command.input.CopySourceRange!);
        return {
          CopyPartResult: { ETag: `"part-${command.input.PartNumber}"` },
        };
      }
      if (command instanceof HeadObjectCommand) {
        if (completed) return { ContentLength: objects.size };
        throw Object.assign(new Error("missing"), {
          $metadata: { httpStatusCode: 404 },
        });
      }
      assert.ok(command instanceof CompleteMultipartUploadCommand);
      completionCalls++;
      assert.deepEqual(command.input.MultipartUpload?.Parts, [
        { PartNumber: 1, ETag: '"part-1"' },
        { PartNumber: 2, ETag: '"part-2"' },
      ]);
      completed = true;
      throw new Error("completion acknowledgement lost");
    },
  } as unknown as S3Client;
  const resume = () =>
    s3RerunCopy(
      {
        appEnv: "local",
        databaseUrl: "postgresql://127.0.0.1/test",
        endpoint: "http://127.0.0.1:9999",
        publicEndpoint: "http://127.0.0.1:9999",
        region: "us-east-1",
        bucket: "fixture",
        accessKeyId: "fixture",
        secretAccessKey: "fixture",
      },
      provider,
    );
  let progress = await resume().advance(objects, {
    uploadId: null,
    partTags: [],
    targetReady: false,
  });
  progress = await resume().advance(objects, progress);
  progress = await resume().advance(objects, progress);
  assert.deepEqual(ranges, [
    `bytes=0-${copyPartBytes - 1}`,
    `bytes=${copyPartBytes}-${objects.size - 1}`,
  ]);
  await assert.rejects(
    resume().advance(objects, progress),
    /acknowledgement lost/,
  );
  assert.deepEqual(await resume().advance(objects, progress), {
    uploadId: null,
    partTags: [],
    targetReady: true,
  });
  assert.equal(completionCalls, 1);
});
