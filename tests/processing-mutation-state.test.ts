import { describe, expect, it, vi } from "vitest";
import {
  captureProcessingMutationState,
  restoreAbsentProcessingResources,
  verifyAbsentProcessingResources,
} from "../scripts/capture-processing-mutation-state.mjs";

const config = {
  environment: "staging",
  accountId: "a".repeat(32),
  databaseName: "hereisit-processing-staging",
  bucketName: "hereisit-processing-staging",
  usageLogBucketName: "hereisit-processing-usage-staging",
  workerScriptName: "hereisit-processing-staging",
  queueName: "hereisit-image-jobs-staging",
  dlqName: "hereisit-image-jobs-dlq-staging",
  pdfQueueName: "hereisit-pdf-jobs-staging",
  pdfDlqName: "hereisit-pdf-jobs-dlq-staging",
};

describe("pre-mutation processing resource state", () => {
  it("models exact resources that were absent before provisioning", () => {
    const state = captureProcessingMutationState({
      config,
      inventory: {
        d1: [],
        r2: [{ name: config.bucketName }],
        queues: [{ id: "b".repeat(32), name: config.queueName, deliveryPaused: false }],
        logpush: [],
        workers: [],
        containers: [],
      },
      capturedAt: "2026-08-12T00:00:00.000Z",
    });
    expect(state.absentResources).toEqual([
      "container.image",
      "container.pdf",
      "d1",
      "logpush",
      "queue.image.dlq",
      "queue.pdf.dlq",
      "queue.pdf.primary",
      "r2.usage",
      "worker",
    ]);
    expect(state.resources.queues.image.primary).toMatchObject({ state: "resumed" });
  });

  it("deletes only resources proven absent and refuses drift", async () => {
    const state = captureProcessingMutationState({
      config,
      inventory: { d1: [], r2: [], queues: [], logpush: [], workers: [], containers: [] },
      capturedAt: "2026-08-12T00:00:00.000Z",
    });
    const applyAction = vi.fn(async () => undefined);
    await restoreAbsentProcessingResources({
      state,
      inventory: {
        d1: [{ id: "00000000-0000-4000-8000-000000000001", name: config.databaseName }],
        r2: [{ name: config.bucketName }, { name: config.usageLogBucketName }],
        queues: [
          { id: "1".repeat(32), name: config.queueName },
          { id: "2".repeat(32), name: config.dlqName },
          { id: "3".repeat(32), name: config.pdfQueueName },
          { id: "4".repeat(32), name: config.pdfDlqName },
        ],
        logpush: [{ id: 41, workerScriptName: config.workerScriptName }],
        workers: [{ name: config.workerScriptName }],
        containers: [
          {
            id: "00000000-0000-4000-8000-000000000010",
            name: `${config.workerScriptName}-imageenginecontainer`,
          },
          {
            id: "00000000-0000-4000-8000-000000000011",
            name: `${config.workerScriptName}-pdfenginecontainer`,
          },
        ],
      },
      applyAction,
    });
    expect(applyAction.mock.calls.map(([action]) => action.type)).toEqual([
      "delete-worker",
      "delete-container",
      "delete-container",
      "delete-logpush",
      "delete-queue",
      "delete-queue",
      "delete-queue",
      "delete-queue",
      "delete-r2",
      "delete-r2",
      "delete-d1",
    ]);
    expect(() =>
      verifyAbsentProcessingResources({
        state,
        inventory: { d1: [], r2: [], queues: [], logpush: [], workers: [], containers: [] },
      }),
    ).not.toThrow();
    expect(() =>
      verifyAbsentProcessingResources({
        state,
        inventory: {
          d1: [],
          r2: [],
          queues: [{ id: "1".repeat(32), name: config.queueName }],
          logpush: [],
          workers: [],
          containers: [],
        },
      }),
    ).toThrow(/still exists/i);
  });
});
