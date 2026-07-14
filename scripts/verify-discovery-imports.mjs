import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultEntrypoints = Object.freeze([
  "apps/web/src/app/layout.tsx",
  "apps/web/src/app/page.tsx",
  "apps/web/src/app/tools/page.tsx",
  "apps/web/src/app/my-tools/page.tsx",
  "apps/web/src/app/workflows/page.tsx",
  "apps/web/src/app/robots.ts",
  "apps/web/src/app/sitemap.ts",
  "apps/web/src/components/site-header.tsx",
  "apps/web/src/components/catalog-search.tsx",
  "apps/web/src/components/domain-tool-tabs.tsx",
  "apps/web/src/components/tool-card.tsx",
  "apps/web/src/components/favorite-tool-button.tsx",
  "apps/web/src/components/home-file-launcher.tsx",
  "apps/web/src/components/home-discovery.tsx",
  "apps/web/src/components/my-tools.tsx",
  "apps/web/src/components/tool-catalog-browser.tsx",
  "apps/web/src/components/tool-visit-tracker.tsx",
  "apps/web/src/lib/catalog-pagination.ts",
  "apps/web/src/lib/file-recommendations.ts",
  "apps/web/src/lib/file-selection-detection.ts",
  "apps/web/src/lib/pending-tool-selection.ts",
  "apps/web/src/lib/tool-preferences.ts",
  "apps/web/src/lib/use-pending-tool-files.ts",
  "apps/web/src/lib/use-tool-preferences.ts",
  "packages/tool-registry/src/file-kind.ts",
  "packages/tool-registry/src/tool-catalog.ts",
  "packages/tool-registry/src/tool-discovery.ts",
]);

const sourceExtensions = Object.freeze([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);
const terminalExtensions = new Set([
  ".avif",
  ".bmp",
  ".css",
  ".csv",
  ".eot",
  ".gif",
  ".heic",
  ".heif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".json",
  ".md",
  ".mp3",
  ".mp4",
  ".ogg",
  ".otf",
  ".pdf",
  ".png",
  ".scss",
  ".svg",
  ".ttf",
  ".txt",
  ".wav",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
]);
// Bare packages are not followed from node_modules. Keep this list limited to framework runtimes that
// are expected in discovery source; every other bare runtime edge fails closed.
const allowedExternalPackages = new Set(["next", "react", "react-dom"]);
const NON_LITERAL_IMPORT = "import(<non-literal>)";
const NON_LITERAL_REQUIRE = "require(<non-literal>)";
const forbiddenModulePatterns = Object.freeze([
  /workbench/i,
  /(?:^|[/._-])workers?(?:$|[/._-])/i,
  /browser-runtime/i,
  /(?:^|[/@._-])image-tool(?:$|[/@._-])/i,
  /(?:^|[/@._-])pdf-tool(?:$|[/@._-])/i,
  /(?:^|[/@._-])pdf-lib(?:$|[/@._-])/i,
  /(?:^|[/@._-])fflate(?:$|[/@._-])/i,
  /(?:pdfjs(?:-dist)?|pdf\.js|pdf\.worker)/i,
  /(?:^|[/._-])codecs?(?:$|[/._-])/i,
  /(?:^|[/._-])editors?(?:$|[/._-])/i,
  /(?:^|[/._-])wasm(?:$|[/._-])/i,
  /(?:^|[/@._-])tool-contracts(?:$|[/@._-])/i,
  /(?:^|[/._-])processing-contracts?(?:$|[/._-])/i,
  /^import\(<non-literal>\)$/,
  /^require\(<non-literal>\)$/,
]);

function slash(value) {
  return value.split(path.sep).join("/");
}

function relativeModulePath(absolutePath) {
  return slash(path.relative(repositoryRoot, absolutePath));
}

function isInsideRepository(absolutePath) {
  const relativePath = path.relative(repositoryRoot, absolutePath);
  return (
    relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}

function isForbiddenModule(value) {
  const normalized = slash(value);
  return forbiddenModulePatterns.some((pattern) => pattern.test(normalized));
}

function parseEntrypoints(args) {
  const entrypoints = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--entrypoint" || index + 1 >= args.length) {
      throw new Error(
        "Usage: node scripts/verify-discovery-imports.mjs [--entrypoint <relative-path>]...",
      );
    }
    const entrypoint = args[index + 1];
    if (entrypoint === undefined || entrypoint.startsWith("-")) {
      throw new Error(
        "Usage: node scripts/verify-discovery-imports.mjs [--entrypoint <relative-path>]...",
      );
    }
    entrypoints.push(entrypoint);
    index += 1;
  }
  return entrypoints.length === 0 ? defaultEntrypoints : entrypoints;
}

async function fileExists(absolutePath) {
  try {
    await access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveSourceFile(candidate) {
  const extension = path.extname(candidate).toLowerCase();
  if (sourceExtensions.includes(extension) && (await fileExists(candidate))) return candidate;

  if (extension === "") {
    for (const sourceExtension of sourceExtensions) {
      const fileCandidate = `${candidate}${sourceExtension}`;
      if (await fileExists(fileCandidate)) return fileCandidate;
    }
    for (const sourceExtension of sourceExtensions) {
      const indexCandidate = path.join(candidate, `index${sourceExtension}`);
      if (await fileExists(indexCandidate)) return indexCandidate;
    }
    return undefined;
  }

  if ([".js", ".jsx", ".mjs", ".cjs"].includes(extension)) {
    const withoutExtension = candidate.slice(0, -extension.length);
    for (const sourceExtension of [".ts", ".tsx", ".mts", ".cts"]) {
      const sourceCandidate = `${withoutExtension}${sourceExtension}`;
      if (await fileExists(sourceCandidate)) return sourceCandidate;
    }
  }

  return undefined;
}

function runtimeImportSpecifier(declaration) {
  const clause = declaration.importClause;
  if (clause?.isTypeOnly) return undefined;
  if (clause === undefined || clause.name !== undefined) return declaration.moduleSpecifier.text;
  const bindings = clause.namedBindings;
  if (bindings === undefined || ts.isNamespaceImport(bindings))
    return declaration.moduleSpecifier.text;
  if (bindings.elements.length === 0 || bindings.elements.some((element) => !element.isTypeOnly)) {
    return declaration.moduleSpecifier.text;
  }
  return undefined;
}

function runtimeExportSpecifier(declaration) {
  if (declaration.moduleSpecifier === undefined || declaration.isTypeOnly) return undefined;
  const clause = declaration.exportClause;
  if (clause === undefined || ts.isNamespaceExport(clause)) return declaration.moduleSpecifier.text;
  if (clause.elements.length === 0 || clause.elements.some((element) => !element.isTypeOnly)) {
    return declaration.moduleSpecifier.text;
  }
  return undefined;
}

function stringArgument(call) {
  const argument = call.arguments[0];
  return argument !== undefined && ts.isStringLiteralLike(argument) ? argument.text : undefined;
}

function workerGlobalReference(node) {
  const isWorkerName = (value) => value === "Worker" || value === "SharedWorker";
  const isBrowserGlobal = (value) =>
    ts.isIdentifier(value) && ["globalThis", "self", "window"].includes(value.text);

  if (ts.isIdentifier(node) && isWorkerName(node.text)) {
    const parent = node.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) return undefined;
    if (ts.isPropertyAssignment(parent) && parent.name === node) return undefined;
    return node.text;
  }
  if (
    ts.isPropertyAccessExpression(node) &&
    isBrowserGlobal(node.expression) &&
    isWorkerName(node.name.text)
  ) {
    return node.name.text;
  }
  if (
    ts.isElementAccessExpression(node) &&
    isBrowserGlobal(node.expression) &&
    node.argumentExpression !== undefined &&
    ts.isStringLiteralLike(node.argumentExpression) &&
    isWorkerName(node.argumentExpression.text)
  ) {
    return node.argumentExpression.text;
  }
  return undefined;
}

function workerModuleSpecifier(node) {
  if (!ts.isNewExpression(node) || workerGlobalReference(node.expression) === undefined)
    return undefined;
  const argument = node.arguments?.[0];
  if (argument === undefined) return undefined;
  if (ts.isStringLiteralLike(argument)) return argument.text;
  if (
    ts.isNewExpression(argument) &&
    ts.isIdentifier(argument.expression) &&
    argument.expression.text === "URL"
  ) {
    return stringArgument(argument);
  }
  return undefined;
}

function collectRuntimeSpecifiers(absolutePath, source) {
  const tree = ts.createSourceFile(
    absolutePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    absolutePath.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const specifiers = [];

  function visit(node) {
    if (ts.isTypeNode(node)) return;
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const specifier = runtimeImportSpecifier(node);
      if (specifier !== undefined) specifiers.push(specifier);
      return;
    }
    if (ts.isExportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const specifier = runtimeExportSpecifier(node);
      if (specifier !== undefined) specifiers.push(specifier);
      return;
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression !== undefined &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text);
      return;
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const specifier = stringArgument(node);
        specifiers.push(specifier ?? NON_LITERAL_IMPORT);
      } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        const specifier = stringArgument(node);
        specifiers.push(specifier ?? NON_LITERAL_REQUIRE);
      }
    }
    // Reject the browser global at the point it is referenced, so simple constructor aliases cannot
    // evade the syntax boundary even when the later `new` expression has a neutral identifier.
    if (workerGlobalReference(node) !== undefined) specifiers.push("Worker");
    if (ts.isNewExpression(node) && workerGlobalReference(node.expression) !== undefined) {
      specifiers.push("Worker");
      const workerSpecifier = workerModuleSpecifier(node);
      if (workerSpecifier !== undefined) specifiers.push(workerSpecifier);
    }
    ts.forEachChild(node, visit);
  }

  visit(tree);
  return [...new Set(specifiers)];
}

function workspacePackageParts(specifier) {
  const segments = specifier.split("/");
  const packageSegmentCount = specifier.startsWith("@") ? 2 : 1;
  const packageName = segments.slice(0, packageSegmentCount).join("/");
  const subpathSegments = segments.slice(packageSegmentCount);
  return {
    packageName,
    exportKey: subpathSegments.length === 0 ? "." : `./${subpathSegments.join("/")}`,
  };
}

function selectExportTarget(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const selected = selectExportTarget(candidate);
      if (selected !== undefined) return selected;
    }
    return undefined;
  }
  if (value === null || typeof value !== "object") return undefined;
  for (const condition of [
    "browser",
    "import",
    "default",
    "development",
    "production",
    "node",
    "require",
  ]) {
    const selected = selectExportTarget(value[condition]);
    if (selected !== undefined) return selected;
  }
  for (const [condition, candidate] of Object.entries(value)) {
    if (condition === "types" || condition.startsWith(".")) continue;
    const selected = selectExportTarget(candidate);
    if (selected !== undefined) return selected;
  }
  return undefined;
}

function packageExportTarget(packageJson, exportKey) {
  const exports = packageJson.exports;
  if (typeof exports === "string" || Array.isArray(exports)) {
    return exportKey === "." ? selectExportTarget(exports) : undefined;
  }
  if (exports !== null && typeof exports === "object") {
    const keys = Object.keys(exports);
    if (keys.some((key) => key.startsWith("."))) {
      return selectExportTarget(exports[exportKey]);
    }
    return exportKey === "." ? selectExportTarget(exports) : undefined;
  }
  if (exportKey !== ".") return undefined;
  return typeof packageJson.module === "string"
    ? packageJson.module
    : typeof packageJson.main === "string"
      ? packageJson.main
      : undefined;
}

async function loadWorkspacePackages() {
  const packages = new Map();
  for (const workspaceDirectory of ["apps", "packages"]) {
    const directory = path.join(repositoryRoot, workspaceDirectory);
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const packageRoot = path.join(directory, entry.name);
      const manifestPath = path.join(packageRoot, "package.json");
      if (!(await fileExists(manifestPath))) continue;
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      if (typeof manifest.name === "string") packages.set(manifest.name, { manifest, packageRoot });
    }
  }
  return packages;
}

async function resolveRuntimeSpecifier(fromAbsolutePath, specifier, workspacePackages) {
  if (specifier.startsWith(".")) {
    const extension = path.extname(specifier).toLowerCase();
    if (terminalExtensions.has(extension)) return { kind: "terminal" };
    const resolved = await resolveSourceFile(
      path.resolve(path.dirname(fromAbsolutePath), specifier),
    );
    return resolved === undefined ? { kind: "unresolved" } : { kind: "source", path: resolved };
  }

  if (specifier.startsWith("/")) return { kind: "terminal" };
  const { packageName, exportKey } = workspacePackageParts(specifier);
  const workspacePackage = workspacePackages.get(packageName);
  if (workspacePackage === undefined) {
    return allowedExternalPackages.has(packageName) ? { kind: "terminal" } : { kind: "unresolved" };
  }
  const target = packageExportTarget(workspacePackage.manifest, exportKey);
  if (target === undefined) return { kind: "unresolved" };
  const resolved = await resolveSourceFile(path.resolve(workspacePackage.packageRoot, target));
  return resolved === undefined ? { kind: "unresolved" } : { kind: "source", path: resolved };
}

async function verifyImportBoundary(entrypoints) {
  const workspacePackages = await loadWorkspacePackages();
  const pending = [];
  const seen = new Set();
  const violations = new Set();
  const unresolved = new Set();

  for (const entrypoint of entrypoints) {
    if (path.isAbsolute(entrypoint)) {
      unresolved.add("<absolute-entrypoint>");
      continue;
    }
    const candidate = path.resolve(repositoryRoot, entrypoint);
    if (!isInsideRepository(candidate)) {
      unresolved.add(slash(entrypoint));
      continue;
    }
    const resolved = await resolveSourceFile(candidate);
    if (resolved === undefined) unresolved.add(slash(entrypoint));
    else pending.push(resolved);
  }

  while (pending.length > 0) {
    const absolutePath = pending.shift();
    if (absolutePath === undefined || seen.has(absolutePath)) continue;
    seen.add(absolutePath);
    const modulePath = relativeModulePath(absolutePath);
    if (isForbiddenModule(modulePath)) violations.add(modulePath);

    const source = await readFile(absolutePath, "utf8");
    for (const specifier of collectRuntimeSpecifiers(absolutePath, source)) {
      const edge = `${modulePath} -> ${slash(specifier)}`;
      if (isForbiddenModule(specifier)) {
        violations.add(edge);
        continue;
      }

      const resolution = await resolveRuntimeSpecifier(absolutePath, specifier, workspacePackages);
      if (resolution.kind === "unresolved") {
        unresolved.add(edge);
        continue;
      }
      if (resolution.kind === "source") {
        const targetPath = relativeModulePath(resolution.path);
        if (!isInsideRepository(resolution.path)) unresolved.add(edge);
        else if (isForbiddenModule(targetPath)) violations.add(`${edge} -> ${targetPath}`);
        else pending.push(resolution.path);
      }
    }
  }

  return {
    moduleCount: seen.size,
    unresolved: [...unresolved].sort(),
    violations: [...violations].sort(),
  };
}

try {
  const entrypoints = parseEntrypoints(process.argv.slice(2));
  const result = await verifyImportBoundary(entrypoints);
  if (result.unresolved.length > 0 || result.violations.length > 0) {
    if (result.unresolved.length > 0) {
      console.error("Unresolved discovery import paths:");
      for (const unresolved of result.unresolved) console.error(`- ${unresolved}`);
    }
    if (result.violations.length > 0) {
      console.error("Forbidden discovery import paths:");
      for (const violation of result.violations) console.error(`- ${violation}`);
    }
    process.exitCode = 1;
  } else {
    console.log(`Discovery import boundary passed (${result.moduleCount} modules).`);
  }
} catch (error) {
  const message =
    error instanceof Error && error.message.startsWith("Usage:")
      ? error.message
      : "Discovery import boundary failed.";
  console.error(message);
  process.exitCode = 1;
}
