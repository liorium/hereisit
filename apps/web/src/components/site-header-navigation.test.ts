import { describe, expect, it } from "vitest";
import { globalNavigationLinks } from "./site-header-navigation";

describe("globalNavigationLinks", () => {
  it("contains only destinations users can use now", () => {
    expect(globalNavigationLinks).toEqual([{ href: "/my-tools", label: "내 도구" }]);
  });
});
