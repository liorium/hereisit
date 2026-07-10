import {
  type BatchHandle,
  type BatchImageItem,
  type BatchItemResult,
  type BatchRuntimeEvent,
  IMAGE_TOOL_ID,
  IMAGE_TOOL_VERSION,
  type ToolErrorPayload,
  WORKER_PROTOCOL_VERSION,
  type WorkerEvent,
  type WorkerRequest,
} from "@hereisit/tool-contracts";

export interface RunImageBatchOptions {
  concurrency?: number | "auto";
  onEvent?: (event: BatchRuntimeEvent) => void;
}

const MAX_WORKERS = 2;
const MAX_BATCH_OUTPUT_BYTES = 500 * 1024 * 1024;
const JOB_TIMEOUT_MS = 180_000;

interface WorkerSlot {
  worker: Worker;
  itemIndex?: number;
  jobId?: string;
  generation: number;
  timeoutId?: ReturnType<typeof setTimeout>;
}

function makeJobId(itemId: string): string {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return `${itemId}-${suffix}`;
}

function autoConcurrency(): number {
  const cores = globalThis.navigator?.hardwareConcurrency ?? 2;
  const memory = (globalThis.navigator as (Navigator & { deviceMemory?: number }) | undefined)
    ?.deviceMemory;
  if (memory === undefined || memory <= 4) return 1;
  return Math.max(1, Math.min(MAX_WORKERS, cores - 1));
}

export function supportsBrowserImageRuntime(): boolean {
  return (
    typeof Worker !== "undefined" &&
    typeof OffscreenCanvas !== "undefined" &&
    typeof createImageBitmap !== "undefined"
  );
}

export function runImageBatch(
  items: readonly BatchImageItem[],
  options: RunImageBatchOptions = {},
): BatchHandle {
  let cancelled = false;
  let settled = false;
  let nextIndex = 0;
  let completed = 0;
  let outputBytes = 0;
  let resolveResult: (value: readonly BatchItemResult[]) => void = () => undefined;
  const results: Array<BatchItemResult | undefined> = new Array(items.length);
  const slots = new Set<WorkerSlot>();
  const result = new Promise<readonly BatchItemResult[]>((resolve) => {
    resolveResult = resolve;
  });

  const emit = (event: BatchRuntimeEvent) => {
    try {
      options.onEvent?.(event);
    } catch {
      return;
    }
  };

  const clearSlotTimeout = (slot: WorkerSlot) => {
    if (slot.timeoutId !== undefined) clearTimeout(slot.timeoutId);
    delete slot.timeoutId;
  };

  const finishIfReady = () => {
    if (settled || completed !== items.length) return;
    settled = true;
    for (const slot of slots) {
      clearSlotTimeout(slot);
      slot.worker.terminate();
    }
    slots.clear();
    resolveResult(results.filter((entry): entry is BatchItemResult => entry !== undefined));
  };

  const settleItem = (
    index: number,
    itemResult: BatchItemResult,
    slot: WorkerSlot,
    reuseSlot = true,
  ) => {
    if (results[index] !== undefined) return;
    const item = items[index];
    if (item === undefined) return;
    results[index] = itemResult;
    completed += 1;
    emit({ type: "item-complete", itemId: item.itemId, result: itemResult });
    emit({ type: "batch-progress", completed, total: items.length });
    clearSlotTimeout(slot);
    delete slot.itemIndex;
    delete slot.jobId;
    finishIfReady();
    if (!settled && reuseSlot && slots.has(slot)) void assignNext(slot);
  };

  const replaceCrashedWorker = (slot: WorkerSlot, error: ToolErrorPayload) => {
    if (!slots.has(slot)) return;
    const index = slot.itemIndex;
    clearSlotTimeout(slot);
    slot.worker.terminate();
    slots.delete(slot);
    if (index !== undefined) {
      const item = items[index];
      if (item !== undefined) {
        settleItem(index, { itemId: item.itemId, status: "rejected", error }, slot, false);
      }
    }
    if (!cancelled && !settled && nextIndex < items.length) createSlot();
  };

  const armSlotTimeout = (slot: WorkerSlot) => {
    clearSlotTimeout(slot);
    slot.timeoutId = setTimeout(() => {
      replaceCrashedWorker(slot, {
        code: "WORKER_CRASH",
        message: "이미지 작업 시간이 제한을 넘었습니다.",
        retryable: true,
      });
    }, JOB_TIMEOUT_MS);
  };

  const attachWorker = (slot: WorkerSlot) => {
    slot.worker.onmessage = (message: MessageEvent<WorkerEvent>) => {
      const event = message.data;
      if (event.protocol !== WORKER_PROTOCOL_VERSION || event.type === "ready") return;
      if (event.jobId !== slot.jobId || slot.itemIndex === undefined) return;

      const index = slot.itemIndex;
      const item = items[index];
      if (item === undefined) return;
      if (event.type === "progress") {
        emit({
          type: "item-progress",
          itemId: item.itemId,
          phase: event.phase,
          fraction: event.fraction,
        });
        return;
      }

      if (event.type === "complete") {
        if (outputBytes + event.result.byteLength > MAX_BATCH_OUTPUT_BYTES) {
          settleItem(
            index,
            {
              itemId: item.itemId,
              status: "rejected",
              error: {
                code: "MEMORY_LIMIT",
                message: "배치 결과가 총 500MB 제한을 넘었습니다.",
                retryable: false,
              },
            },
            slot,
          );
        } else {
          outputBytes += event.result.byteLength;
          settleItem(
            index,
            { itemId: item.itemId, status: "fulfilled", value: event.result },
            slot,
          );
        }
      } else {
        settleItem(index, { itemId: item.itemId, status: "rejected", error: event.error }, slot);
      }
    };

    const handleWorkerFailure = () => {
      replaceCrashedWorker(slot, {
        code: "WORKER_CRASH",
        message: "브라우저 작업기가 중단되었습니다.",
        retryable: true,
      });
    };
    slot.worker.onerror = handleWorkerFailure;
    slot.worker.onmessageerror = handleWorkerFailure;
  };

  async function assignNext(slot: WorkerSlot): Promise<void> {
    if (cancelled || settled || slot.itemIndex !== undefined || nextIndex >= items.length) return;
    const index = nextIndex++;
    const item = items[index];
    if (item === undefined) return;
    const generation = ++slot.generation;
    slot.itemIndex = index;
    slot.jobId = makeJobId(item.itemId);
    armSlotTimeout(slot);

    try {
      const bytes = await item.file.arrayBuffer();
      if (cancelled || slot.generation !== generation || slot.itemIndex !== index) return;
      const request: WorkerRequest = {
        protocol: 1,
        type: "run",
        jobId: slot.jobId,
        tool: IMAGE_TOOL_ID,
        toolVersion: IMAGE_TOOL_VERSION,
        input: {
          name: item.file.name,
          mimeHint: item.file.type,
          byteLength: item.file.size,
          bytes,
        },
        spec: item.spec,
      };
      slot.worker.postMessage(request, [bytes]);
    } catch {
      settleItem(
        index,
        {
          itemId: item.itemId,
          status: "rejected",
          error: { code: "CORRUPT_INPUT", message: "파일을 읽지 못했습니다.", retryable: true },
        },
        slot,
      );
    }
  }

  function rejectRemaining(error: ToolErrorPayload): void {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      const item = items[index];
      if (item === undefined || results[index] !== undefined) continue;
      const itemResult: BatchItemResult = { itemId: item.itemId, status: "rejected", error };
      results[index] = itemResult;
      completed += 1;
      emit({ type: "item-complete", itemId: item.itemId, result: itemResult });
      emit({ type: "batch-progress", completed, total: items.length });
    }
    finishIfReady();
  }

  function createSlot(): void {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./image.worker.ts", import.meta.url), {
        type: "module",
        name: "hereisit-image-worker",
      });
    } catch {
      if (slots.size === 0) {
        rejectRemaining({
          code: "WORKER_CRASH",
          message: "브라우저 작업기를 시작하지 못했습니다.",
          retryable: true,
        });
      }
      return;
    }
    const slot: WorkerSlot = { worker, generation: 0 };
    slots.add(slot);
    attachWorker(slot);
    void assignNext(slot);
  }

  if (items.length === 0) {
    settled = true;
    resolveResult([]);
  } else if (!supportsBrowserImageRuntime()) {
    settled = true;
    resolveResult(
      items.map((item) => ({
        itemId: item.itemId,
        status: "rejected" as const,
        error: {
          code: "UNSUPPORTED_INPUT" as const,
          message: "이 브라우저는 로컬 이미지 처리를 지원하지 않습니다.",
          retryable: false,
        },
      })),
    );
  } else {
    const requested =
      options.concurrency === "auto" || options.concurrency === undefined
        ? autoConcurrency()
        : Number.isFinite(options.concurrency) && options.concurrency > 0
          ? options.concurrency
          : 1;
    const concurrency = Math.max(1, Math.min(MAX_WORKERS, Math.floor(requested), items.length));
    for (let index = 0; index < concurrency && !settled; index += 1) createSlot();
  }

  return {
    result,
    cancel() {
      if (cancelled || settled) return;
      cancelled = true;
      for (const slot of slots) {
        clearSlotTimeout(slot);
        slot.worker.terminate();
      }
      slots.clear();
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        if (results[index] === undefined && item !== undefined) {
          results[index] = { itemId: item.itemId, status: "cancelled" };
        }
      }
      settled = true;
      resolveResult(results.filter((entry): entry is BatchItemResult => entry !== undefined));
    },
  };
}
