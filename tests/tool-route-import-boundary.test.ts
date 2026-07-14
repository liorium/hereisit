import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const workbenchModuleNames = new Set([
  "image-workbench",
  "image-watermark-workbench",
  "pdf-workbench",
  "pdf-to-image-workbench",
  "pdf-compress-workbench",
]);

const migratedRoutes = [
  {
    route: "/image/compress",
    sourcePath: "apps/web/src/app/image/compress/page.tsx",
    expectedWorkbench: "image-workbench",
  },
  {
    route: "/image/resize",
    sourcePath: "apps/web/src/app/image/resize/page.tsx",
    expectedWorkbench: "image-workbench",
  },
  {
    route: "/image/convert",
    sourcePath: "apps/web/src/app/image/convert/page.tsx",
    expectedWorkbench: "image-workbench",
  },
  {
    route: "/image/watermark",
    sourcePath: "apps/web/src/app/image/watermark/page.tsx",
    expectedWorkbench: "image-watermark-workbench",
  },
  {
    route: "/pdf/organize",
    sourcePath: "apps/web/src/app/pdf/organize/page.tsx",
    expectedWorkbench: "pdf-workbench",
  },
  {
    route: "/pdf/merge",
    sourcePath: "apps/web/src/app/pdf/merge/page.tsx",
    expectedWorkbench: "pdf-workbench",
  },
  {
    route: "/pdf/split",
    sourcePath: "apps/web/src/app/pdf/split/page.tsx",
    expectedWorkbench: "pdf-workbench",
  },
  {
    route: "/pdf/watermark",
    sourcePath: "apps/web/src/app/pdf/watermark/page.tsx",
    expectedWorkbench: "pdf-workbench",
  },
  {
    route: "/pdf/image-to-pdf",
    sourcePath: "apps/web/src/app/pdf/image-to-pdf/page.tsx",
    expectedWorkbench: "pdf-workbench",
  },
  {
    route: "/pdf/to-image",
    sourcePath: "apps/web/src/app/pdf/to-image/page.tsx",
    expectedWorkbench: "pdf-to-image-workbench",
  },
  {
    route: "/pdf/compress",
    sourcePath: "apps/web/src/app/pdf/compress/page.tsx",
    expectedWorkbench: "pdf-compress-workbench",
  },
] as const;

function getDirectImportModuleNames(sourcePath: string): string[] {
  const absolutePath = resolve(process.cwd(), sourcePath);
  const sourceText = readFileSync(absolutePath, "utf8");
  const sourceFile = ts.createSourceFile(
    absolutePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );

  return sourceFile.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      return [];
    }
    const moduleSpecifier = statement.moduleSpecifier.text;
    const moduleName = moduleSpecifier.split("/").at(-1);
    return moduleName === undefined ? [] : [moduleName];
  });
}

function getWorkbenchImports(sourcePath: string): string[] {
  return getDirectImportModuleNames(sourcePath).filter((moduleName) =>
    workbenchModuleNames.has(moduleName),
  );
}

describe("migrated tool route import boundaries", () => {
  for (const { route, sourcePath, expectedWorkbench } of migratedRoutes) {
    it(`${route} directly imports only its own workbench`, () => {
      expect(getWorkbenchImports(sourcePath)).toEqual([expectedWorkbench]);
    });

    it(`${route} directly imports the catalog detail shell`, () => {
      const imports = getDirectImportModuleNames(sourcePath);

      expect(imports).toContain("tool-detail-page");
      expect(imports).not.toContain("image-tool-page");
      expect(imports).not.toContain("pdf-tool-page");
      expect(imports).not.toContain("pdf-editing-tool-page");
    });
  }
});
