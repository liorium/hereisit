import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  validateProcessingDeploymentEnvironment,
  writeProcessingDeploymentEnvironmentSummary,
} from "../scripts/verify-processing-deployment-environment.mjs";

const secret = "A".repeat(43);
const maintainerSessionId = "123e4567-e89b-42d3-a456-426614174000";
const maintainerSessionHash = createHash("sha256").update(maintainerSessionId).digest("hex");

function validEnvironment(
  deployment: "staging" | "production" = "staging",
): Record<string, string> {
  const prefix = deployment.toUpperCase();
  return {
    CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
    CLOUDFLARE_API_TOKEN: "worker-token-value-1234567890",
    CLOUDFLARE_D1_API_TOKEN: "d1-token-value-12345678901234",
    CLOUDFLARE_LOGPUSH_API_TOKEN: "logs-token-value-12345678901",
    LOGPUSH_R2_ACCESS_KEY_ID: "R2ACCESSKEY1234567890",
    LOGPUSH_R2_SECRET_ACCESS_KEY: "r2-secret-access-key-value-1234567890",
    [`${prefix}_ANALYTICS_READ_TOKEN`]: "analytics-read-token-1234567890",
    [`${prefix}_LOGPUSH_STATUS_TOKEN`]: "logpush-status-token-1234567890",
    [`${prefix}_ABUSE_HMAC_SECRET_CURRENT`]: secret,
    [`${prefix}_ABUSE_HMAC_SECRET_PREVIOUS`]: secret,
    [`${prefix}_MAINTAINER_SESSION_ID`]: maintainerSessionId,
    [`${prefix}_MAINTAINER_HASHES_JSON`]: JSON.stringify([maintainerSessionHash]),
    ALERT_DESTINATION_ADDRESS: "alerts@example.com",
  };
}

describe("processing deployment environment verifier", () => {
  it("accepts a complete staging environment and returns only a content-free summary", () => {
    const environment = validEnvironment();
    const result = validateProcessingDeploymentEnvironment(environment);
    expect(result).toEqual({ ready: true, checked: 13, maintainerHashCount: 1 });

    let output = "";
    writeProcessingDeploymentEnvironmentSummary(environment, {
      write(value: string) {
        output += value;
      },
    });
    expect(JSON.parse(output)).toEqual(result);
    for (const value of Object.values(environment)) expect(output).not.toContain(value);
  });

  it("validates the production-specific credentials without accepting staging substitutes", () => {
    expect(
      validateProcessingDeploymentEnvironment(validEnvironment("production"), "production"),
    ).toEqual({ ready: true, checked: 13, maintainerHashCount: 1 });
    expect(() => validateProcessingDeploymentEnvironment(validEnvironment(), "production")).toThrow(
      "PRODUCTION_ANALYTICS_READ_TOKEN",
    );
  });

  it("rejects every missing required deployment value", () => {
    for (const key of Object.keys(validEnvironment())) {
      const environment = validEnvironment();
      delete environment[key];
      expect(() => validateProcessingDeploymentEnvironment(environment)).toThrow(key);
    }
  });

  it("reports every missing deployment value together without revealing configured values", () => {
    const environment = validEnvironment();
    delete environment.CLOUDFLARE_API_TOKEN;
    environment.CLOUDFLARE_D1_API_TOKEN = "";
    delete environment.ALERT_DESTINATION_ADDRESS;

    let error: unknown;
    try {
      validateProcessingDeploymentEnvironment(environment);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(TypeError);
    const message = (error as TypeError).message;
    expect(message).toContain("CLOUDFLARE_API_TOKEN");
    expect(message).toContain("CLOUDFLARE_D1_API_TOKEN");
    expect(message).toContain("ALERT_DESTINATION_ADDRESS");
    expect(message).not.toContain(environment.CLOUDFLARE_LOGPUSH_API_TOKEN);
    expect(message).not.toContain(environment.LOGPUSH_R2_SECRET_ACCESS_KEY);
  });

  it("requires canonical 32-byte base64url abuse secrets", () => {
    const environment = validEnvironment();
    environment.STAGING_ABUSE_HMAC_SECRET_CURRENT = "not-base64url";
    expect(() => validateProcessingDeploymentEnvironment(environment)).toThrow(
      "STAGING_ABUSE_HMAC_SECRET_CURRENT",
    );
  });

  it("requires a bounded, unique, lowercase SHA-256 maintainer allowlist", () => {
    for (const hashes of [[], ["B".repeat(64)], ["b".repeat(64), "b".repeat(64)]]) {
      const environment = validEnvironment();
      environment.STAGING_MAINTAINER_HASHES_JSON = JSON.stringify(hashes);
      expect(() => validateProcessingDeploymentEnvironment(environment)).toThrow(
        "STAGING_MAINTAINER_HASHES_JSON",
      );
    }
  });

  it("requires the staging maintainer session UUID to be present in the hashed allowlist", () => {
    const environment = validEnvironment();
    environment.STAGING_MAINTAINER_HASHES_JSON = JSON.stringify(["b".repeat(64)]);
    expect(() => validateProcessingDeploymentEnvironment(environment)).toThrow(
      "STAGING_MAINTAINER_SESSION_ID",
    );
  });

  it("rejects non-v4 maintainer UUIDs even when their hash is allowlisted", () => {
    const environment = validEnvironment();
    const versionSeven = "018f47a2-65d4-7f31-a377-5afbb8f53f27";
    environment.STAGING_MAINTAINER_SESSION_ID = versionSeven;
    environment.STAGING_MAINTAINER_HASHES_JSON = JSON.stringify([
      createHash("sha256").update(versionSeven).digest("hex"),
    ]);
    expect(() => validateProcessingDeploymentEnvironment(environment)).toThrow(
      "STAGING_MAINTAINER_SESSION_ID",
    );
  });
});
