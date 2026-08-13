import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256Bytes } from "../scripts/image-lab-common.mjs";
import { verifyDeploymentGateArtifacts } from "../scripts/verify-deployment-gate-artifacts.mjs";

type VerificationInput = {
  attestationFile: string;
  attestationSha256: string;
  configFile: string;
  configSha256: string;
};

function verify(input: VerificationInput) {
  return verifyDeploymentGateArtifacts(input);
}

describe("deployment gate artifact verification", () => {
  it("runs as a strict executable for the staging workflow", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hereisit-deployment-gate-"));
    const attestationFile = join(directory, "worker-version-attestation.json");
    const configFile = join(directory, "wrangler.staging.jsonc");
    const attestation = "reviewed-attestation";
    const config = "reviewed-config";
    try {
      await Promise.all([
        writeFile(attestationFile, attestation, "utf8"),
        writeFile(configFile, config, "utf8"),
      ]);
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
        (resolve) => {
          const child = spawn(
            process.execPath,
            [
              "scripts/verify-deployment-gate-artifacts.mjs",
              "--attestation",
              attestationFile,
              "--attestation-sha256",
              sha256Bytes(attestation),
              "--config",
              configFile,
              "--config-sha256",
              sha256Bytes(config),
            ],
            { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
          );
          let stdout = "";
          let stderr = "";
          child.stdout.setEncoding("utf8").on("data", (chunk) => {
            stdout += chunk;
          });
          child.stderr.setEncoding("utf8").on("data", (chunk) => {
            stderr += chunk;
          });
          child.on("close", (code) => resolve({ code, stdout, stderr }));
        },
      );

      expect(result).toEqual({
        code: 0,
        stdout:
          '{"schema":"hereisit-processing-deployment-gate@1","version":1,"passed":true,"verified":true}\n',
        stderr: "",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("verifies the exact bounded attestation and Wrangler config bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hereisit-deployment-gate-"));
    const attestationFile = join(directory, "worker-version-attestation.json");
    const configFile = join(directory, "wrangler.staging.jsonc");
    const attestation = '{"schema":"hereisit-worker-version-attestations@1"}\n';
    const config = '{"name":"hereisit-processing-staging"}\n';
    try {
      await Promise.all([
        writeFile(attestationFile, attestation, "utf8"),
        writeFile(configFile, config, "utf8"),
      ]);

      await expect(
        verify({
          attestationFile,
          attestationSha256: sha256Bytes(attestation),
          configFile,
          configSha256: sha256Bytes(config),
        }),
      ).resolves.toEqual({
        schema: "hereisit-processing-deployment-gate@1",
        version: 1,
        passed: true,
        verified: true,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects an artifact whose bytes do not match the reviewed digest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hereisit-deployment-gate-"));
    const attestationFile = join(directory, "worker-version-attestation.json");
    const configFile = join(directory, "wrangler.staging.jsonc");
    try {
      await Promise.all([
        writeFile(attestationFile, "changed-attestation", "utf8"),
        writeFile(configFile, "reviewed-config", "utf8"),
      ]);

      await expect(
        verify({
          attestationFile,
          attestationSha256: sha256Bytes("reviewed-attestation"),
          configFile,
          configSha256: sha256Bytes("reviewed-config"),
        }),
      ).rejects.toThrow(/attestation.*hash.*match/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects oversized artifacts even when their digest matches", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hereisit-deployment-gate-"));
    const attestationFile = join(directory, "worker-version-attestation.json");
    const configFile = join(directory, "wrangler.staging.jsonc");
    const attestation = "a".repeat(64 * 1024 + 1);
    try {
      await Promise.all([
        writeFile(attestationFile, attestation, "utf8"),
        writeFile(configFile, "reviewed-config", "utf8"),
      ]);

      await expect(
        verify({
          attestationFile,
          attestationSha256: sha256Bytes(attestation),
          configFile,
          configSha256: sha256Bytes("reviewed-config"),
        }),
      ).rejects.toThrow(/attestation.*maximum size|attestation.*exceeds/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
