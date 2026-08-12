function required(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === "") throw new TypeError(`${name} is required`);
  return value;
}

function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = Number(env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new TypeError(`${name} is invalid`);
  return value;
}

export interface PdfEngineConfig {
  readonly host: string;
  readonly port: number;
  readonly workspaceRoot: string;
  readonly shutdownGraceMs: number;
  readonly maxWallMs: number;
  readonly maxRssBytes: number;
  readonly maxWorkspaceBytes: number;
  readonly build: { readonly protocol: 1; readonly engineBuildId: string; readonly qpdf: string };
}

export function readPdfEngineConfig(env: NodeJS.ProcessEnv = process.env): PdfEngineConfig {
  return {
    host: env.HOST ?? "0.0.0.0",
    port: integer(env, "PORT", 8080, 1, 65_535),
    workspaceRoot: env.WORKSPACE_ROOT ?? "/tmp/hereisit-pdf-engine",
    shutdownGraceMs: integer(env, "ROLLOUT_GRACE_MS", 30_000, 0, 120_000),
    maxWallMs: integer(env, "PDF_MAX_WALL_MS", 45_000, 1, 120_000),
    maxRssBytes: integer(
      env,
      "PDF_MAX_RSS_BYTES",
      768 * 1024 * 1024,
      1024 * 1024,
      2 * 1024 * 1024 * 1024,
    ),
    maxWorkspaceBytes: integer(
      env,
      "PDF_MAX_WORKSPACE_BYTES",
      256 * 1024 * 1024,
      64 * 1024 * 1024,
      1024 * 1024 * 1024,
    ),
    build: {
      protocol: 1,
      engineBuildId: required(env.ENGINE_BUILD_ID, "ENGINE_BUILD_ID"),
      qpdf: required(env.QPDF_BUILD_ID, "QPDF_BUILD_ID"),
    },
  };
}
