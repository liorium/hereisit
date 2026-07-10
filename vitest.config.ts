import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    clearMocks: true,
    restoreMocks: true,
    passWithNoTests: false,
    include: [
      "apps/**/src/**/*.{test,spec}.ts",
      "packages/**/src/**/*.{test,spec}.ts",
      "tests/**/*.{test,spec}.ts",
    ],
    exclude: ["**/node_modules/**", "**/.next/**", "**/dist/**", "**/e2e/**"],
    maxWorkers: 2,
    testTimeout: 5_000,
  },
});
