import { describe, expect, it } from "vitest";
import { runProcessingStagingBrowserSmoke } from "../scripts/support/processing-staging-smoke-runtime.mjs";

const transientPolicyFailure = new Error(
  "processing staging smoke failed [maintainer-policy-execution]",
);

describe("processing staging smoke readiness", () => {
  it("retries a transient maintainer policy fallback before accepting readiness", async () => {
    let attempts = 0;
    const result = await runProcessingStagingBrowserSmoke({}, async () => {
      attempts += 1;
      if (attempts < 3) throw transientPolicyFailure;
      return "ready";
    });

    expect(result).toBe("ready");
    expect(attempts).toBe(3);
  });

  it("stops after three transient maintainer policy fallbacks", async () => {
    let attempts = 0;
    await expect(
      runProcessingStagingBrowserSmoke({}, async () => {
        attempts += 1;
        throw transientPolicyFailure;
      }),
    ).rejects.toThrow(transientPolicyFailure.message);

    expect(attempts).toBe(3);
  });
});
