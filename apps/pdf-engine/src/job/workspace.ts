import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface PdfJobWorkspace {
  readonly root: string;
  readonly home: string;
  readonly tmp: string;
  readonly input: string;
  readonly request: string;
  readonly status: string;
  readonly structuralCandidate: string;
  readonly optimizedCandidate: string;
  readonly output: string;
  readonly diagnostic: string;
}

export async function createPdfJobWorkspace(root: string, jobId: string): Promise<PdfJobWorkspace> {
  if (!JOB_ID.test(jobId)) throw new TypeError("job ID is invalid");
  process.umask(0o077);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const jobRoot = join(root, jobId);
  const home = join(jobRoot, "home");
  const tmp = join(jobRoot, "tmp");
  await mkdir(jobRoot, { mode: 0o700 });
  await Promise.all([mkdir(home, { mode: 0o700 }), mkdir(tmp, { mode: 0o700 })]);
  return {
    root: jobRoot,
    home,
    tmp,
    input: join(jobRoot, "input.bin"),
    request: join(jobRoot, "request.json"),
    status: join(jobRoot, "status.json"),
    structuralCandidate: join(jobRoot, "structural.pdf"),
    optimizedCandidate: join(jobRoot, "optimized.pdf"),
    output: join(jobRoot, "output.pdf"),
    diagnostic: join(jobRoot, "diagnostic.stderr"),
  };
}

export async function removePdfJobWorkspace(workspace: PdfJobWorkspace): Promise<void> {
  await rm(workspace.root, { recursive: true, force: true });
}

export async function scrubPdfWorkspaceRoot(root: string): Promise<void> {
  process.umask(0o077);
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const name of await readdir(root))
    await rm(join(root, name), { recursive: true, force: true });
  if ((await readdir(root)).length !== 0) throw new Error("workspace scrub failed");
}

export async function writeExactPdfInput(input: {
  readonly path: string;
  readonly stream: AsyncIterable<Uint8Array | string>;
  readonly expectedBytes: number;
}): Promise<void> {
  if (!Number.isSafeInteger(input.expectedBytes) || input.expectedBytes < 1)
    throw new RangeError("expected input length is invalid");
  const partial = `${input.path}.${randomUUID()}.partial`;
  const file = await open(partial, "wx", 0o600);
  let bytes = 0;
  try {
    for await (const raw of input.stream) {
      const chunk = Buffer.from(raw);
      bytes += chunk.byteLength;
      if (bytes > input.expectedBytes) throw new RangeError("input length mismatch");
      await file.write(chunk);
    }
    if (bytes !== input.expectedBytes) throw new RangeError("input length mismatch");
    await file.sync();
    await file.close();
    await rename(partial, input.path);
  } catch (error) {
    await file.close().catch(() => undefined);
    await rm(partial, { force: true });
    throw error;
  }
  if ((await stat(input.path)).size !== input.expectedBytes)
    throw new RangeError("input length mismatch");
}

export async function hashExactPdfInput(
  stream: AsyncIterable<Uint8Array | string>,
  expectedBytes: number,
): Promise<string> {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1)
    throw new RangeError("expected input length is invalid");
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const raw of stream) {
    const chunk = Buffer.from(raw);
    bytes += chunk.byteLength;
    if (bytes > expectedBytes) throw new RangeError("input length mismatch");
    hash.update(chunk);
  }
  if (bytes !== expectedBytes) throw new RangeError("input length mismatch");
  return hash.digest("hex");
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const partial = `${path}.${randomUUID()}.partial`;
  const file = await open(partial, "wx", 0o600);
  try {
    await file.write(Buffer.from(JSON.stringify(value)));
    await file.sync();
    await file.close();
    await rename(partial, path);
    const directory = await open(dirname(path), "r");
    await directory.sync();
    await directory.close();
  } catch (error) {
    await file.close().catch(() => undefined);
    await rm(partial, { force: true });
    throw error;
  }
}

export async function publishOutputAtomic(candidate: string, output: string): Promise<void> {
  await rename(candidate, output);
  const directory = await open(dirname(output), "r");
  await directory.sync();
  await directory.close();
}

export async function captureBoundedDiagnostic(
  stream: AsyncIterable<Uint8Array | string>,
  path: string,
  maxBytes = 8192,
): Promise<void> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 8192)
    throw new RangeError("diagnostic limit is invalid");
  const file = await open(path, "w", 0o600);
  let written = 0;
  try {
    for await (const raw of stream) {
      const chunk = Buffer.from(raw).subarray(0, Math.max(0, maxBytes - written));
      if (chunk.byteLength > 0) await file.write(chunk);
      written += chunk.byteLength;
    }
    await file.sync();
  } finally {
    await file.close();
  }
}
