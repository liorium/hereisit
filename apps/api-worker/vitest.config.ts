import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const projectDirectory = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: {
        configPath: "./wrangler.local.jsonc",
      },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(join(projectDirectory, "migrations")),
          ABUSE_HMAC_SECRET_CURRENT: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
          ABUSE_HMAC_SECRET_PREVIOUS: "__79_Pv6-fj39vX08_Lx8O_u7ezr6uno5-bl5OPi4eA",
        },
      },
    })),
  ],
  test: {
    include: ["src/bounded-json.test.ts", "src/routes/policy.test.ts", "test/**/*.test.ts"],
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
