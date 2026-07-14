import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  availableToolEntries,
  plannedToolEntries,
} from "../packages/tool-registry/src/tool-catalog";

it("backs every available route with a static page", async () => {
  for (const tool of availableToolEntries) {
    await expect(
      access(path.join(process.cwd(), "apps/web/src/app", tool.route.slice(1), "page.tsx")),
    ).resolves.toBeUndefined();
  }
});

it("does not reserve a route for roadmap cards", async () => {
  expect(plannedToolEntries.every((tool) => !("route" in tool))).toBe(true);
  await expect(
    access(path.join(process.cwd(), "apps/web/src/app/media/video-compress/page.tsx")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it("derives static-export tool pages and bundle profiles from authored data", async () => {
  const source = await readFile(
    path.join(process.cwd(), "scripts/verify-static-export.mjs"),
    "utf8",
  );

  expect(source).toMatch(
    /import\s*\{[^}]*availableToolEntries[^}]*plannedToolEntries[^}]*\}\s*from "\.\.\/packages\/tool-registry\/src\/tool-catalog\.ts";/,
  );
  expect(source).toContain(
    'import { toolImplementationConfig } from "../apps/web/src/lib/tool-implementations.ts";',
  );
  expect(source).toContain("bundleProfile: toolImplementationConfig[tool.id].bundleProfile");
  expect(source).toContain("const plannedRouteFiles = plannedToolEntries.map");
  expect(source).toContain("file: routeHtmlFile(tool.route)");
  expect(source).not.toMatch(/const toolPages\s*=\s*\[/);
  expect(source).not.toMatch(/toolPages\.length\s*,\s*11/);
});
