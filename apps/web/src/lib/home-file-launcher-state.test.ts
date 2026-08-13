import { describe, expect, it } from "vitest";
import { launcherStatusMessage } from "./home-file-launcher-state";

describe("launcherStatusMessage", () => {
  it("announces progress and completion without treating an error as ordinary status", () => {
    expect(launcherStatusMessage({ mode: "detecting", completed: 1, total: 2 })).toBe(
      "1/2개 형식 확인 중",
    );
    expect(launcherStatusMessage({ mode: "result", itemCount: 2 })).toBe("2개 파일 형식 확인 완료");
    expect(launcherStatusMessage({ mode: "error" })).toBeNull();
  });
});
