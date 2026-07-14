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

const representativeRoutes = [
  {
    route: "/image/compress",
    sourcePath: "apps/web/src/app/image/compress/page.tsx",
    expectedWorkbench: "image-workbench",
  },
  {
    route: "/pdf/organize",
    sourcePath: "apps/web/src/app/pdf/organize/page.tsx",
    expectedWorkbench: "pdf-workbench",
  },
] as const;

function getWorkbenchImports(sourcePath: string): string[] {
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
    return moduleName !== undefined && workbenchModuleNames.has(moduleName) ? [moduleName] : [];
  });
}

describe("representative tool route import boundaries", () => {
  for (const { route, sourcePath, expectedWorkbench } of representativeRoutes) {
    it(`${route} directly imports only its own workbench`, () => {
      expect(getWorkbenchImports(sourcePath)).toEqual([expectedWorkbench]);
    });
  }
});
