import { describe, expect, it } from "vitest";
import { runProcessingStagingBrowserSmoke } from "../scripts/support/processing-staging-smoke-runtime.mjs";

const transientPolicyFailure = new Error(
  "processing staging smoke failed [maintainer-policy-execution]",
);

describe("processing staging smoke readiness", () => {
  it("retries a transient maintainer policy fallback before accepting readiness", async () => {
    let attempts = 0;
    let waits = 0;
    const result = await runProcessingStagingBrowserSmoke(
      {},
      async () => {
        attempts += 1;
        if (attempts < 3) throw transientPolicyFailure;
        return "ready";
      },
      async () => {
        waits += 1;
      },
    );

    expect(result).toBe("ready");
    expect(attempts).toBe(3);
    expect(waits).toBe(2);
  });

  it("stops after twelve transient maintainer policy fallbacks", async () => {
    let attempts = 0;
    let waits = 0;
    await expect(
      runProcessingStagingBrowserSmoke(
        {},
        async () => {
          attempts += 1;
          throw transientPolicyFailure;
        },
        async () => {
          waits += 1;
        },
      ),
    ).rejects.toThrow(transientPolicyFailure.message);

    expect(attempts).toBe(12);
    expect(waits).toBe(11);
  });

  it.each([
    "public-policy",
    "maintainer-policy-missing",
    "maintainer-policy-identity",
  ])("retries transient %s propagation", async (stage) => {
    let attempts = 0;
    const result = await runProcessingStagingBrowserSmoke(
      {},
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error(`processing staging smoke failed [${stage}]`);
        return "ready";
      },
      async () => undefined,
    );

    expect(result).toBe("ready");
    expect(attempts).toBe(2);
  });

  it("retries a transient upstream rate limit", async () => {
    let attempts = 0;
    let waits = 0;
    const result = await runProcessingStagingBrowserSmoke(
      {},
      async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("processing staging smoke failed [job-create-upstream-rate-limit]");
        }
        return "ready";
      },
      async () => {
        waits += 1;
      },
    );

    expect(result).toBe("ready");
    expect(attempts).toBe(2);
    expect(waits).toBe(1);
  });
});
