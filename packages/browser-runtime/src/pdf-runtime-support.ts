export const PDF_JOB_TIMEOUT_MS = 180_000;

export function makePdfJobId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

export function supportsBrowserPdfRuntime(): boolean {
  return typeof Worker !== "undefined" && typeof File !== "undefined";
}
