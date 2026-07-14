import { afterEach, describe, expect, it, vi } from "vitest";
import type { DetectedFileItem } from "./file-recommendations";
import {
  clearPendingToolSelection,
  consumePendingToolSelection,
  PENDING_TOOL_SELECTION_TTL_MS,
  replacePendingToolSelection,
} from "./pending-tool-selection";

function detectedFile(name = "graphic.png"): DetectedFileItem {
  return {
    file: new File([Uint8Array.of(1)], name, { type: "image/png" }),
    detectedKind: "image/png",
  };
}

afterEach(() => {
  clearPendingToolSelection();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("pending tool selection", () => {
  it("replaces the previous selection and restarts its lifetime", async () => {
    vi.useFakeTimers();
    const first = detectedFile("first.png");
    const replacement = detectedFile("replacement.png");

    replacePendingToolSelection("image.compress", [first], 1_000);
    await vi.advanceTimersByTimeAsync(30_000);
    replacePendingToolSelection("image.resize", [replacement], 31_000);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(consumePendingToolSelection("image.resize", 61_000)).toEqual({
      state: "consumed",
      items: [replacement],
    });
  });

  it("consumes just before 60 seconds and is empty on a second consume", () => {
    const png = detectedFile();
    replacePendingToolSelection("image.compress", [png], 1_000);

    expect(consumePendingToolSelection("image.compress", 60_999)).toEqual({
      state: "consumed",
      items: [png],
    });
    expect(consumePendingToolSelection("image.compress", 61_000)).toEqual({ state: "empty" });
  });

  it("expires at exactly 60 seconds when consumed before the timer callback", () => {
    replacePendingToolSelection("image.compress", [detectedFile()], 1_000);

    expect(consumePendingToolSelection("image.compress", 61_000)).toEqual({ state: "expired" });
    expect(consumePendingToolSelection("image.compress", 61_001)).toEqual({ state: "empty" });
  });

  it("proactively clears file references at exactly 60 seconds and leaves one expiry result", async () => {
    vi.useFakeTimers();
    replacePendingToolSelection("image.compress", [detectedFile()], 1_000);

    await vi.advanceTimersByTimeAsync(PENDING_TOOL_SELECTION_TTL_MS);

    expect(consumePendingToolSelection("image.compress", 61_000)).toEqual({ state: "expired" });
    expect(consumePendingToolSelection("image.compress", 61_001)).toEqual({ state: "empty" });
  });

  it("clears the selection after an exact target mismatch", () => {
    replacePendingToolSelection("image.compress", [detectedFile()], 1_000);

    expect(consumePendingToolSelection("image.resize", 1_001)).toEqual({
      state: "target-mismatch",
    });
    expect(consumePendingToolSelection("image.compress", 1_002)).toEqual({ state: "empty" });
  });

  it("clears the selection explicitly", () => {
    replacePendingToolSelection("image.compress", [detectedFile()], 1_000);

    clearPendingToolSelection();

    expect(consumePendingToolSelection("image.compress", 1_001)).toEqual({ state: "empty" });
  });

  it("copies and freezes the item array without serializing its File references", () => {
    const png = detectedFile();
    const source = [png];
    replacePendingToolSelection("image.compress", source, 1_000);

    source.length = 0;
    const result = consumePendingToolSelection("image.compress", 1_001);

    expect(result).toEqual({ state: "consumed", items: [png] });
    if (result.state !== "consumed") throw new Error("Expected the selection to be consumed");
    expect(Object.isFrozen(result.items)).toBe(true);
    expect(result.items[0]?.file).toBe(png.file);
  });

  it("never calls storage, history, object URL, or console functions", () => {
    const forbiddenFunctions = {
      localGet: vi.fn(),
      localSet: vi.fn(),
      localRemove: vi.fn(),
      sessionGet: vi.fn(),
      sessionSet: vi.fn(),
      sessionRemove: vi.fn(),
      pushState: vi.fn(),
      replaceState: vi.fn(),
      createObjectURL: vi.fn(() => "blob:forbidden"),
      revokeObjectURL: vi.fn(),
      log: vi.spyOn(console, "log").mockImplementation(() => undefined),
      info: vi.spyOn(console, "info").mockImplementation(() => undefined),
      warn: vi.spyOn(console, "warn").mockImplementation(() => undefined),
      error: vi.spyOn(console, "error").mockImplementation(() => undefined),
      debug: vi.spyOn(console, "debug").mockImplementation(() => undefined),
    };
    vi.stubGlobal("localStorage", {
      getItem: forbiddenFunctions.localGet,
      setItem: forbiddenFunctions.localSet,
      removeItem: forbiddenFunctions.localRemove,
    });
    vi.stubGlobal("sessionStorage", {
      getItem: forbiddenFunctions.sessionGet,
      setItem: forbiddenFunctions.sessionSet,
      removeItem: forbiddenFunctions.sessionRemove,
    });
    vi.stubGlobal("history", {
      pushState: forbiddenFunctions.pushState,
      replaceState: forbiddenFunctions.replaceState,
    });
    vi.stubGlobal("URL", {
      createObjectURL: forbiddenFunctions.createObjectURL,
      revokeObjectURL: forbiddenFunctions.revokeObjectURL,
    });

    replacePendingToolSelection("image.compress", [detectedFile()], 1_000);
    consumePendingToolSelection("image.compress", 1_001);
    clearPendingToolSelection();

    for (const forbiddenFunction of Object.values(forbiddenFunctions)) {
      expect(forbiddenFunction).not.toHaveBeenCalled();
    }
  });
});
