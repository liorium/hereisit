import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

const root = process.cwd();
const entrypoints = [
  "packages/tool-registry/src/tool-catalog.ts",
  "packages/tool-registry/src/tool-discovery.ts",
  "packages/tool-registry/src/file-kind.ts",
  "apps/web/src/lib/site-identity.ts",
  "apps/web/src/lib/metadata.ts",
];
const allowedRuntimePackages = new Set(["@hereisit/tool-registry/catalog"]);
const forbidden =
  /(tool-contracts|browser-runtime|image-tool|pdf-tool|components\/|\.worker|pdfjs|codec|wasm|react|tool-implementations)/i;

async function visit(file: string, seen: Set<string>): Promise<void> {
  const absolute = path.resolve(root, file);
  if (seen.has(absolute)) return;
  seen.add(absolute);
  const source = await readFile(absolute, "utf8");
  const tree = ts.createSourceFile(absolute, source, ts.ScriptTarget.Latest, true);
  for (const statement of tree.statements) {
    const declaration =
      ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)
        ? statement
        : undefined;
    if (
      declaration?.moduleSpecifier === undefined ||
      !ts.isStringLiteral(declaration.moduleSpecifier)
    ) {
      continue;
    }
    const typeOnly = ts.isImportDeclaration(declaration)
      ? declaration.importClause?.isTypeOnly === true
      : declaration.isTypeOnly;
    if (typeOnly) continue;
    const specifier = declaration.moduleSpecifier.text;
    expect(specifier).not.toMatch(forbidden);
    if (!specifier.startsWith(".")) {
      expect(allowedRuntimePackages.has(specifier)).toBe(true);
      continue;
    }
    const resolved = path.resolve(
      path.dirname(absolute),
      specifier.endsWith(".ts") ? specifier : `${specifier}.ts`,
    );
    await visit(path.relative(root, resolved), seen);
  }
  function rejectDynamicImport(node: ts.Node): void {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      throw new Error(
        `Dynamic import is forbidden in lightweight module: ${path.relative(root, absolute)}`,
      );
    }
    ts.forEachChild(node, rejectDynamicImport);
  }
  rejectDynamicImport(tree);
}

it("keeps discovery and metadata import closures lightweight", async () => {
  const seen = new Set<string>();
  for (const entrypoint of entrypoints) await visit(entrypoint, seen);
  expect([...seen].map((file) => path.relative(root, file)).sort()).toContain(
    "packages/tool-registry/src/tool-catalog.ts",
  );
});
