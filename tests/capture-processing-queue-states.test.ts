import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { captureProcessingQueueStates } from "../scripts/capture-processing-queue-states.mjs";

describe("processing Queue rollback snapshot", () => {
  it("captures all four independently verified prior states without assuming image is paused", async () => {
    const root = await mkdtemp(join(tmpdir(), "queue-state-"));
    try {
      const output = join(root, "states.json");
      const inspect = vi.fn(async ({ queueName }: { queueName: string }) => ({
        queue: queueName,
        state: queueName === "image" ? "resumed" : "paused",
        verified: true,
      }));
      const value = await captureProcessingQueueStates({
        accountId: "a".repeat(32),
        apiToken: "token",
        output,
        inspect,
        queues: {
          "image-primary": "image",
          "image-dlq": "image-dlq",
          "pdf-primary": "pdf",
          "pdf-dlq": "pdf-dlq",
        },
      });
      expect(value.queues["image-primary"].state).toBe("resumed");
      expect(inspect).toHaveBeenCalledTimes(4);
      expect(JSON.parse(await readFile(output, "utf8"))).toEqual(value);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an incomplete or unverified snapshot", async () => {
    await expect(
      captureProcessingQueueStates({
        accountId: "a".repeat(32),
        queues: {},
        apiToken: "token",
        inspect: vi.fn(),
      }),
    ).rejects.toThrow(/four/);
  });
});
