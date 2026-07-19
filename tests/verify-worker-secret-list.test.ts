import { describe, expect, it } from "vitest";
import { verifyWorkerSecretList } from "../scripts/verify-worker-secret-list.mjs";

const secrets = [
  { name: "ABUSE_HMAC_SECRET_CURRENT", type: "secret_text" },
  { name: "ABUSE_HMAC_SECRET_PREVIOUS", type: "secret_text" },
  { name: "ANALYTICS_READ_TOKEN", type: "secret_text" },
  { name: "LOGPUSH_STATUS_TOKEN", type: "secret_text" },
];

describe("Worker secret inventory verifier", () => {
  it("accepts exactly the required name/type inventory without reading values", () => {
    expect(verifyWorkerSecretList([...secrets].reverse())).toEqual({ verified: true, count: 4 });
  });

  it.each([
    ["missing", secrets.slice(1)],
    ["duplicate", [...secrets.slice(0, 3), secrets[0]]],
    ["fifth", [...secrets, { name: "EXTRA_SECRET", type: "secret_text" }]],
    ["wrong type", [{ ...secrets[0], type: "plain_text" }, ...secrets.slice(1)]],
    ["plaintext field", [{ ...secrets[0], value: "must-not-be-read" }, ...secrets.slice(1)]],
  ])("rejects a %s inventory", (_label, input) => {
    expect(() => verifyWorkerSecretList(input)).toThrow();
  });
});
