import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it.each([
  [undefined, "2026-08-15"],
  ["", "2026-08-15"],
  ["1767225600", "2026-01-01"],
])("exports a reproducible native build date for epoch %s", (epoch, expected) => {
  const env = { ...process.env, TZ: "Pacific/Honolulu" };
  delete env.SOURCE_DATE_EPOCH;
  if (epoch !== undefined) env.SOURCE_DATE_EPOCH = epoch;
  const result = spawnSync(
    "bash",
    [
      "-c",
      "source \"$1\"; node -e 'console.log(new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString().slice(0, 10))'",
      "native-build-date",
      resolve("apps/image-engine/native/build-common.sh"),
    ],
    { env, encoding: "utf8" },
  );
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe(expected);
});
