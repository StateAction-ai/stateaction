import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import { OpsInputError } from "./redact.js";

export const CHUNK_BYTES = 64 * 1024;
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_LOG_FILES = 8;
export const MAX_TOTAL_LOG_BYTES = 4 * 1024 * 1024;
export const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

type ReadFn = (
  fd: number,
  buffer: Uint8Array,
  offset: number,
  length: number,
  position: number | null,
) => number;

/**
 * Read at most `max` bytes from one already-open descriptor. It never trusts a
 * prior `stat` size: it reads in bounded chunks, stops after seeing byte
 * max + 1 and rejects, so a file that grows after it was opened (or a stream
 * that never ends) cannot exceed the limit or exhaust memory. `read` is an
 * injectable seam for tests.
 */
export function readBoundedFd(
  fd: number,
  max: number,
  read: ReadFn = readSync,
): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const want = Math.min(CHUNK_BYTES, max + 1 - total);
    const chunk = Buffer.allocUnsafe(want);
    const got = read(fd, chunk, 0, want, null);
    if (got === 0) break;
    total += got;
    if (total > max) throw new OpsInputError("file too large");
    chunks.push(chunk.subarray(0, got));
  }
  return Buffer.concat(chunks, total);
}

/** Regular, non-symlink file opened with O_NOFOLLOW; size-checked and read from the SAME descriptor. */
export function readRegularFile(path: string, max = MAX_FILE_BYTES): Buffer {
  const named = lstatSync(path);
  if (named.isSymbolicLink() || !named.isFile())
    throw new OpsInputError("not a regular file");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new OpsInputError("not a regular file");
    if (info.size > max) throw new OpsInputError("file too large");
    return readBoundedFd(fd, max);
  } finally {
    closeSync(fd);
  }
}

/** Finite log intake: reject (never silently drop) extra files or excess total bytes. */
export function readLogFiles(
  paths: readonly string[],
  reader: (path: string, max: number) => Buffer = readRegularFile,
): string[] {
  if (paths.length > MAX_LOG_FILES)
    throw new OpsInputError(`too many --log files (max ${MAX_LOG_FILES})`);
  let budget = MAX_TOTAL_LOG_BYTES;
  return paths.map((p) => {
    const bytes = reader(p, Math.min(budget, MAX_FILE_BYTES));
    budget -= bytes.length;
    return bytes.toString("utf8");
  });
}
