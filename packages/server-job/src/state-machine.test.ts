import { describe, expect, it } from "vitest";
import { transitionJobState } from "./state-machine";

const legalTransitions = {
  created: ["uploading", "cancelled", "expired"],
  uploading: ["queued", "cancelled", "failed", "expired"],
  queued: ["running", "cancelled", "failed", "expired"],
  running: ["queued", "succeeded", "failed", "cancelled", "expired"],
  succeeded: ["expired"],
  failed: ["expired"],
  cancelled: ["expired"],
  expired: [],
} as const;

const states = Object.keys(legalTransitions) as (keyof typeof legalTransitions)[];

describe("transitionJobState", () => {
  it("allows every edge in the exact lifecycle graph", () => {
    for (const current of states) {
      for (const next of legalTransitions[current]) {
        expect(transitionJobState(current, next)).toBe(next);
      }
    }
  });

  it("rejects every edge outside the lifecycle graph", () => {
    for (const current of states) {
      for (const next of states) {
        if (!(legalTransitions[current] as readonly string[]).includes(next)) {
          expect(() => transitionJobState(current, next)).toThrow();
        }
      }
    }
  });

  it("protects a terminal success from returning to execution", () => {
    expect(() => transitionJobState("succeeded", "running")).toThrow("terminal");
  });
});
