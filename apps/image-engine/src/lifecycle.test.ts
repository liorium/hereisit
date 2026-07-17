import { describe, expect, it, vi } from "vitest";
import { shutdownEngine } from "./lifecycle";

describe("engine rollout shutdown", () => {
  it("stops admission, waits for idle, and closes without cancellation", async () => {
    const order: string[] = [];
    const cancelActive = vi.fn();
    await shutdownEngine({
      graceMs: 30_000,
      controller: {
        stopAccepting: () => order.push("stop-admission"),
        waitForIdle: async (graceMs) => {
          order.push(`wait:${graceMs}`);
          return true;
        },
        cancelActive,
      },
      closeServer: async () => {
        order.push("close-server");
      },
    });
    expect(order).toEqual(["stop-admission", "wait:30000", "close-server"]);
    expect(cancelActive).not.toHaveBeenCalled();
  });

  it("cancels and erases an active job after rollout grace expires", async () => {
    const order: string[] = [];
    await shutdownEngine({
      graceMs: 50,
      controller: {
        stopAccepting: () => order.push("stop-admission"),
        waitForIdle: async () => false,
        cancelActive: async () => {
          order.push("cancel-active");
        },
      },
      closeServer: async () => {
        order.push("close-server");
      },
    });
    expect(order).toEqual(["stop-admission", "cancel-active", "close-server"]);
  });
});
