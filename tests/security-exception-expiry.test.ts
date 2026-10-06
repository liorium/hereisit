import { describe, expect, it } from "vitest";
import { checkSecurityExceptionExpiry } from "../scripts/check-security-exception-expiry.mjs";

const document = {
  schemaVersion: 1,
  exceptions: [
    {
      cve: "CVE-2026-1234",
      affectedPackage: "test-library",
      affectedVersion: "1.0.0",
      affectedScope: "engine",
      affectedDigest: `sha256:${"a".repeat(64)}`,
      exploitabilityEvidence: "Synthetic expiry boundary fixture.",
      owner: "test-owner",
      approvalReference: "https://example.test/approval/1",
      expiresAt: "2026-10-12T18:00:00.000Z",
    },
  ],
};
const expiry = Date.parse(document.exceptions[0].expiresAt);

describe("security exception deadline monitor", () => {
  it("reports the 72-hour boundary without changing the approved exception", () => {
    const before = JSON.stringify(document);
    expect(
      checkSecurityExceptionExpiry([document], new Date(expiry - 72 * 3600000 - 1))[0].due,
    ).toBe(false);
    expect(checkSecurityExceptionExpiry([document], new Date(expiry - 72 * 3600000))[0].due).toBe(
      true,
    );
    expect(JSON.stringify(document)).toBe(before);
    expect(checkSecurityExceptionExpiry([{ schemaVersion: 1, exceptions: [] }])).toEqual([]);
  });

  it("rejects expired or invalid exceptions instead of reporting a healthy deadline", () => {
    expect(() => checkSecurityExceptionExpiry([document], new Date(expiry))).toThrow("expired");
    expect(() =>
      checkSecurityExceptionExpiry([
        { schemaVersion: 1, exceptions: [{ ...document.exceptions[0], expiresAt: "invalid" }] },
      ]),
    ).toThrow();
  });
});
