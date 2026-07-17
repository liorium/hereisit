import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface JobWorkspace {
  readonly root: string;
  readonly home: string;
  readonly tmp: string;
  readonly input: string;
  readonly request: string;
  readonly output: string;
  readonly result: string;
  readonly status: string;
  readonly diagnostic: string;
}

function validateJobId(jobId: string): void {
  if (!JOB_ID_PATTERN.test(jobId)) throw new TypeError("job ID is invalid");
}

export async function createJobWorkspace(root: string, jobId: string): Promise<JobWorkspace> {
  validateJobId(jobId);
  process.umask(0o077);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const workspaceRoot = join(root, jobId);
  const home = join(workspaceRoot, "home");
  const tmp = join(workspaceRoot, "tmp");
  await mkdir(workspaceRoot, { mode: 0o700 });
  await Promise.all([mkdir(home, { mode: 0o700 }), mkdir(tmp, { mode: 0o700 })]);
  return {
    root: workspaceRoot,
    home,
    tmp,
    input: join(workspaceRoot, "input.bin"),
    request: join(workspaceRoot, "request.json"),
    output: join(workspaceRoot, "output.bin"),
    result: join(workspaceRoot, "result.json"),
    status: join(workspaceRoot, "status.json"),
    diagnostic: join(workspaceRoot, "diagnostic.stderr"),
  };
}

export async function removeJobWorkspace(workspace: JobWorkspace): Promise<void> {
  await rm(workspace.root, { recursive: true, force: true });
}

export async function scrubWorkspaceRoot(root: string): Promise<void> {
  process.umask(0o077);
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(root))
    await rm(join(root, entry), { recursive: true, force: true });
  if ((await readdir(root)).length !== 0) throw new Error("workspace scrub failed");
}

export async function writeExactInput(input: {
  readonly path: string;
  readonly stream: AsyncIterable<Uint8Array | string>;
  readonly expectedBytes: number;
}): Promise<string> {
  if (!Number.isSafeInteger(input.expectedBytes) || input.expectedBytes < 1) {
    throw new RangeError("expected input length is invalid");
  }
  const temporary = `${input.path}.partial`;
  const file = await open(temporary, "wx", 0o600);
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const raw of input.stream) {
      const chunk = typeof raw === "string" ? Buffer.from(raw) : Buffer.from(raw);
      bytes += chunk.byteLength;
      if (bytes > input.expectedBytes) throw new RangeError("input length mismatch");
      hash.update(chunk);
      await file.write(chunk);
    }
    if (bytes !== input.expectedBytes) throw new RangeError("input length mismatch");
    await file.sync();
  } catch (error) {
    await file.close().catch(() => undefined);
    await rm(temporary, { force: true });
    throw error;
  }
  await file.close();
  await rename(temporary, input.path);
  if ((await stat(input.path)).size !== input.expectedBytes) {
    await rm(input.path, { force: true });
    throw new RangeError("input length mismatch");
  }
  return hash.digest("hex");
}

export async function hashExactInput(input: {
  readonly stream: AsyncIterable<Uint8Array | string>;
  readonly expectedBytes: number;
}): Promise<string> {
  if (!Number.isSafeInteger(input.expectedBytes) || input.expectedBytes < 1) {
    throw new RangeError("expected input length is invalid");
  }
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const raw of input.stream) {
    const chunk = Buffer.from(raw);
    bytes += chunk.byteLength;
    if (bytes > input.expectedBytes) throw new RangeError("input length mismatch");
    hash.update(chunk);
  }
  if (bytes !== input.expectedBytes) throw new RangeError("input length mismatch");
  return hash.digest("hex");
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.partial`;
  const bytes = Buffer.from(JSON.stringify(value));
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.write(bytes);
    await file.sync();
  } catch (error) {
    await file.close().catch(() => undefined);
    await rm(temporary, { force: true });
    throw error;
  }
  await file.close();
  await rename(temporary, path);
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function captureBoundedDiagnostic(
  stream: AsyncIterable<Uint8Array | string>,
  path: string,
  maxBytes = 8 * 1024,
): Promise<void> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 8 * 1024) {
    throw new RangeError("diagnostic limit is invalid");
  }
  const file = await open(path, "wx", 0o600);
  let written = 0;
  try {
    for await (const raw of stream) {
      const chunk = Buffer.from(raw);
      const remaining = Math.max(0, maxBytes - written);
      if (remaining > 0) {
        const bounded = chunk.subarray(0, remaining);
        await file.write(bounded);
        written += bounded.byteLength;
      }
    }
    await file.sync();
  } finally {
    await file.close();
  }
}
