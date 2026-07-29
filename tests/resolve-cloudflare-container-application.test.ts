import { describe, expect, it } from "vitest";
import { resolveContainerApplication } from "../scripts/resolve-cloudflare-container-application.mjs";

const accountId = "0123456789abcdef0123456789abcdef";
const applicationId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const image = `registry.cloudflare.com/${accountId}/hereisit-image-engine@sha256:${"d".repeat(64)}`;
const input = {
  environment: "staging" as const,
  accountId,
  workerScriptName: "hereisit-processing-staging",
  engineImage: image,
  observedAt: "2026-07-19T11:00:00.000Z",
};

function application(overrides: Record<string, unknown> = {}) {
  return {
    id: applicationId,
    name: "hereisit-processing-staging-imageenginecontainer",
    state: "ready",
    instances: 0,
    image,
    version: 1,
    updated_at: "2026-07-29T09:49:00.377999872Z",
    created_at: "2026-07-29T09:48:59.340999936Z",
    ...overrides,
  };
}

describe("Cloudflare Container application resolver", () => {
  it("selects the exact Worker/class application and seals its immutable coordinates", () => {
    const result = resolveContainerApplication({
      ...input,
      applications: [
        application({ id: "ffffffff-1111-4222-8333-444444444444", name: "another-app" }),
        application(),
      ],
    });

    expect(result).toMatchObject({
      schema: "hereisit-container-provider-scope@1",
      version: 1,
      environment: "staging",
      accountId,
      observedAt: input.observedAt,
      application: {
        id: applicationId,
        name: "hereisit-processing-staging-imageenginecontainer",
        image,
        version: 1,
      },
    });
    expect(result.verificationSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(result)).not.toMatch(/token|secret/i);
  });

  it.each([
    ["missing", []],
    ["duplicate", [application(), application({ id: "ffffffff-1111-4222-8333-444444444444" })]],
    ["degraded", [application({ state: "degraded" })]],
    ["mutable image", [application({ image: image.replace(/@sha256:.+$/, ":latest") })]],
    ["unexpected schema", [application({ owner: "unknown" })]],
  ])("rejects a %s application inventory", (_label, applications) => {
    expect(() => resolveContainerApplication({ ...input, applications })).toThrow();
  });
});
