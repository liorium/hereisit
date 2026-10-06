import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("pins one official database digest per run and rejects an invalid registry response", () => {
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
  const start = workflow.indexOf('          TRIVY_DB_DIGEST="');
  const end = workflow.indexOf("          mkdir -p .artifacts/runtime/trivy-cache", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const shell = `set -euo pipefail\ndocker() { printf '%s\\n' "$MOCK_REGISTRY_MANIFEST"; }\n${workflow.slice(start, end)}`;
  const directory = mkdtempSync(join(tmpdir(), "release-db-"));
  try {
    const output = join(directory, "output");
    const digest = `sha256:${"a".repeat(64)}`;
    const env = { ...process.env, GITHUB_OUTPUT: output, TRIVY_DB_DIGEST: "obsolete-manual-pin" };
    execFileSync("bash", ["-c", shell], {
      env: {
        ...env,
        MOCK_REGISTRY_MANIFEST: `Name: ghcr.io/aquasecurity/trivy-db:2\nDigest: ${digest}`,
      },
    });
    expect(readFileSync(output, "utf8")).toBe(`trivy-db-digest=${digest}\n`);
    for (const manifest of ["Digest: invalid", "registry unavailable"]) {
      expect(() =>
        execFileSync("bash", ["-c", shell], {
          env: { ...env, MOCK_REGISTRY_MANIFEST: manifest },
          stdio: "pipe",
        }),
      ).toThrow();
    }
    expect(readFileSync(output, "utf8")).toBe(`trivy-db-digest=${digest}\n`);
    expect(workflow).toContain("ghcr.io/aquasecurity/trivy-db@$TRIVY_DB_DIGEST");
    expect(workflow).toContain(
      '--trivy-db-digest "$' + '{{ steps.security.outputs.trivy-db-digest }}"',
    );
    expect(workflow).not.toContain("vars.TRIVY_DB_DIGEST");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
