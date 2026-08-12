import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { promisify } from "node:util";

const artifacts = [
  "/usr/local/bin/qpdf",
  "/app/dist/server.mjs",
  "/app/dist/self-test.mjs",
  "/licenses/qpdf/LICENSE.txt",
  "/licenses/qpdf/NOTICE.md",
  "/licenses/debian/libjpeg62-turbo/copyright",
  "/licenses/debian/libssl3/copyright",
] as const;

export async function runPdfEngineSelfTest(
  dependencies: {
    readonly access?: (path: string, mode: number) => Promise<void>;
    readonly uid?: () => number;
    readonly qpdfVersion?: () => Promise<string>;
  } = {},
) {
  const getUid = dependencies.uid ?? process.getuid;
  if (getUid === undefined) throw new Error("runtime UID is unavailable");
  const uid = getUid();
  if (uid !== 10001) throw new Error("unexpected runtime UID");
  const check = dependencies.access ?? access;
  await Promise.all(
    artifacts.map((path) =>
      check(path, path.endsWith("qpdf") ? constants.R_OK | constants.X_OK : constants.R_OK),
    ),
  );
  const version = await (
    dependencies.qpdfVersion ??
    (async () =>
      (
        await promisify(execFile)("/usr/local/bin/qpdf", ["--version"], {
          encoding: "utf8",
          timeout: 5000,
        })
      ).stdout)
  )();
  if (!/^qpdf version 12\.4\.0(?:\s|$)/u.test(version))
    throw new Error("unexpected qpdf runtime version");
  return { qpdf: "12.4.0", uid, artifacts: artifacts.length };
}

if (process.argv[1]?.endsWith("self-test.mjs"))
  process.stdout.write(`${JSON.stringify({ ok: true, ...(await runPdfEngineSelfTest()) })}\n`);
