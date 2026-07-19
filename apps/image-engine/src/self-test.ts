import { constants } from "node:fs";
import { access } from "node:fs/promises";

const executableArtifacts = [
  "/usr/local/bin/cjpeg",
  "/usr/local/bin/djpeg",
  "/usr/local/bin/jpegtran",
  "/usr/local/bin/jpeg-coeff-verify",
  "/usr/local/bin/oxipng",
  "/usr/local/bin/png-smart",
  "/usr/local/bin/cwebp",
  "/usr/local/bin/dwebp",
] as const;

const readableArtifacts = ["/usr/local/lib/libvips.so", "/app/dist/job/job-runner.mjs"] as const;

export async function runEngineSelfTest(
  dependencies: {
    readonly access?: (path: string, mode: number) => Promise<void>;
    readonly loadSharpVersions?: () => Promise<{ readonly sharp?: string; readonly vips?: string }>;
  } = {},
): Promise<{ readonly sharp: string; readonly vips: string; readonly artifacts: number }> {
  const checkAccess = dependencies.access ?? access;
  await Promise.all([
    ...executableArtifacts.map((path) => checkAccess(path, constants.R_OK | constants.X_OK)),
    ...readableArtifacts.map((path) => checkAccess(path, constants.R_OK)),
  ]);
  const versions = await (
    dependencies.loadSharpVersions ?? (async () => (await import("sharp")).default.versions)
  )();
  if (versions.sharp !== "0.35.3") throw new Error("unexpected Sharp runtime version");
  if (versions.vips !== "8.18.4") throw new Error("unexpected global libvips runtime version");
  return {
    sharp: versions.sharp,
    vips: versions.vips,
    artifacts: executableArtifacts.length + readableArtifacts.length,
  };
}
