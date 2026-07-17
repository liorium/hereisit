import type { EngineBuildInfo } from "./contract";

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === "") throw new TypeError(`${name} is required`);
  return value;
}

export interface EngineConfig {
  readonly host: string;
  readonly port: number;
  readonly workspaceRoot: string;
  readonly shutdownGraceMs: number;
  readonly build: EngineBuildInfo;
}

export function readEngineConfig(env: NodeJS.ProcessEnv = process.env): EngineConfig {
  const port = Number(env.PORT ?? "8080");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
    throw new TypeError("PORT is invalid");
  const shutdownGraceMs = Number(env.ROLLOUT_GRACE_MS ?? "30000");
  if (!Number.isSafeInteger(shutdownGraceMs) || shutdownGraceMs < 0 || shutdownGraceMs > 120_000) {
    throw new TypeError("ROLLOUT_GRACE_MS is invalid");
  }
  return {
    host: env.HOST ?? "0.0.0.0",
    port,
    workspaceRoot: env.WORKSPACE_ROOT ?? "/work",
    shutdownGraceMs,
    build: {
      protocol: 1,
      engineBuildId: required(env.ENGINE_BUILD_ID, "ENGINE_BUILD_ID"),
      codecs: {
        jpeg: required(env.JPEG_CODEC_BUILD_ID, "JPEG_CODEC_BUILD_ID"),
        png: required(env.PNG_CODEC_BUILD_ID, "PNG_CODEC_BUILD_ID"),
        webp: required(env.WEBP_CODEC_BUILD_ID, "WEBP_CODEC_BUILD_ID"),
        transform: required(env.TRANSFORM_BUILD_ID, "TRANSFORM_BUILD_ID"),
      },
    },
  };
}
