import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  validateProcessingDeploymentEnvironment,
  writeProcessingDeploymentEnvironmentSummary,
} from "../scripts/verify-processing-deployment-environment.mjs";

const secret = "A".repeat(43);
const maintainerSessionId = "018f47a2-65d4-7f31-a377-5afbb8f53f27";
const maintainerSessionHash = createHash("sha256").update(maintainerSessionId).digest("hex");

function validEnvironment(): Record<string, string> {
  return {
    CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
    CLOUDFLARE_API_TOKEN: "worker-token-value-1234567890",
    CLOUDFLARE_D1_API_TOKEN: "d1-token-value-12345678901234",
    CLOUDFLARE_LOGPUSH_API_TOKEN: "logs-token-value-12345678901",
    LOGPUSH_R2_ACCESS_KEY_ID: "R2ACCESSKEY1234567890",
    LOGPUSH_R2_SECRET_ACCESS_KEY: "r2-secret-access-key-value-1234567890",
    STAGING_ANALYTICS_READ_TOKEN: "analytics-read-token-1234567890",
    STAGING_LOGPUSH_STATUS_TOKEN: "logpush-status-token-1234567890",
    STAGING_ABUSE_HMAC_SECRET_CURRENT: secret,
    STAGING_ABUSE_HMAC_SECRET_PREVIOUS: secret,
    STAGING_MAINTAINER_SESSION_ID: maintainerSessionId,
    STAGING_MAINTAINER_HASHES_JSON: JSON.stringify([maintainerSessionHash]),
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

  it("rejects every missing required deployment value", () => {
    for (const key of Object.keys(validEnvironment())) {
      const environment = validEnvironment();
      delete environment[key];
      expect(() => validateProcessingDeploymentEnvironment(environment)).toThrow(key);
    }
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
});
