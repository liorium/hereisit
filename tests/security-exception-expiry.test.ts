import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkSecurityExceptionExpiry } from "../scripts/check-security-exception-expiry.mjs";

const document = JSON.parse(
  readFileSync("apps/image-engine/security/vulnerability-exceptions.json", "utf8"),
);
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
