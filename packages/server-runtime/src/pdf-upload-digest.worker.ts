/// <reference lib="webworker" />

import { PDF_OPTIMIZE_MAX_FILE_BYTES } from "@hereisit/tool-contracts/pdf-optimize";

const PROTOCOL = 1;
const CONSTANTS = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

class IncrementalSha256 {
  readonly #state = Uint32Array.from([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  readonly #buffer = new Uint8Array(64);
  readonly #words = new Uint32Array(64);
  #bufferLength = 0;
  #byteLength = 0;

  update(bytes: Uint8Array): void {
    this.#byteLength += bytes.byteLength;
    let offset = 0;
    while (offset < bytes.byteLength) {
      const length = Math.min(64 - this.#bufferLength, bytes.byteLength - offset);
      this.#buffer.set(bytes.subarray(offset, offset + length), this.#bufferLength);
      this.#bufferLength += length;
      offset += length;
      if (this.#bufferLength === 64) {
        this.#compress(this.#buffer);
        this.#bufferLength = 0;
      }
    }
  }

  digest(): Uint8Array {
    const bitLength = this.#byteLength * 8;
    this.#buffer[this.#bufferLength] = 0x80;
    this.#bufferLength += 1;
    if (this.#bufferLength > 56) {
      this.#buffer.fill(0, this.#bufferLength);
      this.#compress(this.#buffer);
      this.#bufferLength = 0;
    }
    this.#buffer.fill(0, this.#bufferLength, 56);
    const view = new DataView(this.#buffer.buffer);
    view.setUint32(56, Math.floor(bitLength / 0x1_0000_0000), false);
    view.setUint32(60, bitLength >>> 0, false);
    this.#compress(this.#buffer);
    const output = new Uint8Array(32);
    const outputView = new DataView(output.buffer);
    for (let index = 0; index < this.#state.length; index += 1) {
      outputView.setUint32(index * 4, this.#state[index] as number, false);
    }
    return output;
  }

  #compress(block: Uint8Array): void {
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    for (let index = 0; index < 16; index += 1)
      this.#words[index] = view.getUint32(index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const previous15 = this.#words[index - 15] as number;
      const previous2 = this.#words[index - 2] as number;
      const sigma0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3);
      const sigma1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10);
      this.#words[index] =
        ((this.#words[index - 16] as number) +
          sigma0 +
          (this.#words[index - 7] as number) +
          sigma1) >>>
        0;
    }
    let [a, b, c, d, e, f, g, h] = this.#state;
    for (let index = 0; index < 64; index += 1) {
      const bigSigma1 =
        rotateRight(e as number, 6) ^ rotateRight(e as number, 11) ^ rotateRight(e as number, 25);
      const choice = ((e as number) & (f as number)) ^ (~(e as number) & (g as number));
      const first =
        ((h as number) +
          bigSigma1 +
          choice +
          (CONSTANTS[index] as number) +
          (this.#words[index] as number)) >>>
        0;
      const bigSigma0 =
        rotateRight(a as number, 2) ^ rotateRight(a as number, 13) ^ rotateRight(a as number, 22);
      const majority =
        (((a as number) & (b as number)) ^
          ((a as number) & (c as number)) ^
          ((b as number) & (c as number))) >>>
        0;
      const second = (bigSigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = ((d as number) + first) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (first + second) >>> 0;
    }
    this.#state[0] = ((this.#state[0] as number) + (a as number)) >>> 0;
    this.#state[1] = ((this.#state[1] as number) + (b as number)) >>> 0;
    this.#state[2] = ((this.#state[2] as number) + (c as number)) >>> 0;
    this.#state[3] = ((this.#state[3] as number) + (d as number)) >>> 0;
    this.#state[4] = ((this.#state[4] as number) + (e as number)) >>> 0;
    this.#state[5] = ((this.#state[5] as number) + (f as number)) >>> 0;
    this.#state[6] = ((this.#state[6] as number) + (g as number)) >>> 0;
    this.#state[7] = ((this.#state[7] as number) + (h as number)) >>> 0;
  }
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function digestPdfStream(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<string> {
  const reader = stream.getReader();
  const digest = new IncrementalSha256();
  try {
    for (;;) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const next = await reader.read();
      if (next.done) break;
      digest.update(next.value);
    }
    return `sha-256=${base64(digest.digest())}`;
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

type ActiveJob = { readonly jobId: string; readonly controller: AbortController };
let active: ActiveJob | undefined;
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}
const workerScope = typeof self === "undefined" ? undefined : (self as DedicatedWorkerGlobalScope);
if (workerScope !== undefined && typeof workerScope.postMessage === "function") {
  workerScope.onmessage = (event: MessageEvent<unknown>) => {
    const message = event.data;
    if (typeof message !== "object" || message === null || Array.isArray(message)) return;
    const record = message as Record<string, unknown>;
    if (record.protocol !== PROTOCOL || typeof record.jobId !== "string") return;
    if (record.type === "cancel" && exactKeys(record, ["protocol", "type", "jobId"])) {
      if (active?.jobId === record.jobId) active.controller.abort();
      return;
    }
    if (
      record.type !== "digest" ||
      !exactKeys(record, ["protocol", "type", "jobId", "file"]) ||
      !(record.file instanceof File) ||
      active !== undefined
    )
      return;
    if (
      record.file.type !== "application/pdf" ||
      record.file.size < 1 ||
      record.file.size > PDF_OPTIMIZE_MAX_FILE_BYTES
    ) {
      workerScope.postMessage({ protocol: PROTOCOL, type: "failed", jobId: record.jobId });
      return;
    }
    const job = { jobId: record.jobId, controller: new AbortController() };
    active = job;
    void digestPdfStream(record.file.stream(), job.controller.signal)
      .then(
        (digest) => {
          if (active === job && !job.controller.signal.aborted) {
            workerScope.postMessage({
              protocol: PROTOCOL,
              type: "complete",
              jobId: job.jobId,
              digest,
            });
          }
        },
        () => {
          if (active === job && !job.controller.signal.aborted) {
            workerScope.postMessage({ protocol: PROTOCOL, type: "failed", jobId: job.jobId });
          }
        },
      )
      .finally(() => {
        if (active === job) active = undefined;
      });
  };
  workerScope.postMessage({ protocol: PROTOCOL, type: "ready" });
}
