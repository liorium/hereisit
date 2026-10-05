import { describe, expect, it, vi } from "vitest";
import {
  createAccountingEmailSender,
  formatAccountingAlert,
  sendAccountingAlert,
} from "./accounting-alerts";

const health = {
  epoch: "a".repeat(32),
  status: "degraded" as const,
  reason: "PROVIDER_UNAVAILABLE" as const,
  evaluatedAt: 100,
  pendingHourKey: 1,
  unresolvedSinceHourKey: 1,
};
describe("accounting alerts", () => {
  it("formats only fixed operational metadata", () => {
    expect(formatAccountingAlert(health, "production")).toEqual({
      subject: "HereIsIt production accounting degraded",
      text: "Environment: production\nReason: PROVIDER_UNAVAILABLE\nFirst unresolved hour: 1\nInspect: processing preflight accounting status\n",
    });
    expect(() =>
      formatAccountingAlert(
        { ...health, reason: "injected\r\nBcc: secret" as never },
        "production",
      ),
    ).toThrow();
  });
  it("requires explicit validated email configuration", () => {
    expect(createAccountingEmailSender({})).toBeNull();
    expect(
      createAccountingEmailSender({
        binding: { send: vi.fn() } as unknown as SendEmail,
        from: "bad\r\nBcc: x@example.com",
        to: "operator@example.com",
      }),
    ).toBeNull();
  });
  it("alert storage failure never becomes a safety write", async () => {
    const db = {
      withSession: () => {
        throw Error("database unavailable");
      },
    } as unknown as D1Database;
    await expect(
      sendAccountingAlert({ db, health, now: 100, environment: "production", send: vi.fn() }),
    ).resolves.toBe("failed");
  });
});
