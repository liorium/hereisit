import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const temporaryRoots: string[] = [];

afterEach(async () =>
  Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true }))),
);

async function writeTool(directory: string, name: string, source: string) {
  const path = join(directory, name);
  await writeFile(path, source);
  await chmod(path, 0o755);
}

async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), "hereisit-runtime-deps-"));
  temporaryRoots.push(workspace);
  const bin = join(workspace, "bin");
  const sourceRoot = join(workspace, "sources");
  const searchRoot = join(workspace, "search");
  const runtimeRoot = join(workspace, "runtime");
  const libraryRoot = join(sourceRoot, "usr/lib/x86_64-linux-gnu");
  await Promise.all([mkdir(bin), mkdir(searchRoot), mkdir(libraryRoot, { recursive: true })]);
  await Promise.all([
    mkdir(join(runtimeRoot, "etc/ssl/certs"), { recursive: true }),
    mkdir(join(runtimeRoot, "usr/lib/locale/C.utf8"), { recursive: true }),
  ]);
  await writeFile(join(runtimeRoot, "etc/os-release"), "NAME=Ubuntu\n");
  await writeFile(join(runtimeRoot, "etc/ssl/certs/ca-certificates.crt"), "fixture certificates\n");
  await writeFile(join(searchRoot, "engine"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00]));
  await Promise.all([
    writeFile(join(libraryRoot, "libc.so.6"), "fixture libc\n"),
    writeFile(join(libraryRoot, "libz.so.1.3.1"), "fixture zlib\n"),
    writeFile(join(libraryRoot, "ld-linux-x86-64.so.2"), "fixture loader\n"),
    writeFile(join(libraryRoot, "libno-copyright.so.1"), "fixture without copyright\n"),
  ]);

  await writeTool(
    bin,
    "ldd",
    `#!/usr/bin/env bash
case "\${LDD_MODE:-ok}" in
  error) printf 'fixture ldd exploded\\n' >&2; exit 23 ;;
  missing) printf 'libmissing.so.1 => not found\\n' ;;
  unowned) printf 'libunowned.so.1 => /lib/x86_64-linux-gnu/libunowned.so.1 (0x1)\\n' ;;
  no-copyright) printf 'libno-copyright.so.1 => /lib/x86_64-linux-gnu/libno-copyright.so.1 (0x1)\\n' ;;
  *) cat <<'EOF'
libc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x1)
libz.so.1 => /lib/x86_64-linux-gnu/libz.so.1 (0x2)
    /lib64/ld-linux-x86-64.so.2 (0x3)
EOF
esac
`,
  );
  await writeTool(
    bin,
    "realpath",
    `#!/usr/bin/env bash
path="\${!#}"
case "$path" in
  */libc.so.6) printf '/usr/lib/x86_64-linux-gnu/libc.so.6\\n' ;;
  */libz.so.1) printf '/usr/lib/x86_64-linux-gnu/libz.so.1.3.1\\n' ;;
  */ld-linux-x86-64.so.2) printf '/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2\\n' ;;
  */libunowned.so.1) printf '/usr/lib/x86_64-linux-gnu/libunowned.so.1\\n' ;;
  */libno-copyright.so.1) printf '/usr/lib/x86_64-linux-gnu/libno-copyright.so.1\\n' ;;
  *) exit 1 ;;
esac
`,
  );
  await writeTool(
    bin,
    "dpkg-query",
    `#!/usr/bin/env bash
package="\${!#}"
case "$1:$package" in
  -S:*libc.so.6|-S:*ld-linux-x86-64.so.2) printf 'libc6:amd64: %s\\n' "$package" ;;
  -S:*libz.so.1.3.1) printf 'zlib1g:amd64: %s\\n' "$package" ;;
  -S:*libno-copyright.so.1) printf 'fixture-no-copyright:amd64: %s\\n' "$package" ;;
  -S:*) printf 'no package owns %s\\n' "$package" >&2; exit 1 ;;
  -s:base-files|-s:ca-certificates|-s:fixture-no-copyright|-s:libc-bin|-s:libc6|-s:zlib1g)
    printf 'Package: %s\\nStatus: install ok installed\\n' "$package"
    ;;
  -W:base-files|-W:ca-certificates|-W:fixture-no-copyright|-W:libc-bin|-W:libc6|-W:zlib1g)
    printf '24.04-fixture'
    ;;
  *) exit 2 ;;
esac
`,
  );
  await writeTool(
    bin,
    "install",
    `#!/usr/bin/env bash
source="$2"
[[ "$source" == /usr/lib/* ]] && source="$FAKE_SOURCE_ROOT$source"
exec /usr/bin/install "$1" "$source" "$3"
`,
  );

  return {
    runtimeRoot,
    searchRoot,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_SOURCE_ROOT: sourceRoot,
    },
  };
}

it("copies every dependency path and inventories packaged non-ELF runtime assets", async () => {
  const { runtimeRoot, searchRoot, env } = await fixture();
  const result = spawnSync(
    "bash",
    ["scripts/copy-distroless-runtime-deps.sh", runtimeRoot, searchRoot],
    { encoding: "utf8", env },
  );

  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe(
    "base-files\t24.04-fixture\nca-certificates\t24.04-fixture\nlibc-bin\t24.04-fixture\nlibc6\t24.04-fixture\nzlib1g\t24.04-fixture\n",
  );
  await expect(
    readFile(join(runtimeRoot, "usr/lib/x86_64-linux-gnu/libc.so.6"), "utf8"),
  ).resolves.toBe("fixture libc\n");
  await expect(
    readFile(join(runtimeRoot, "usr/lib/x86_64-linux-gnu/libz.so.1"), "utf8"),
  ).resolves.toBe("fixture zlib\n");
  await expect(
    readFile(join(runtimeRoot, "usr/lib/x86_64-linux-gnu/libz.so.1.3.1"), "utf8"),
  ).resolves.toBe("fixture zlib\n");
  await expect(readFile(join(runtimeRoot, "usr/lib64/ld-linux-x86-64.so.2"), "utf8")).resolves.toBe(
    "fixture loader\n",
  );
  await expect(
    readFile(join(runtimeRoot, "usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2"), "utf8"),
  ).resolves.toBe("fixture loader\n");
  await expect(
    readFile(join(runtimeRoot, "var/lib/dpkg/status.d/libc6"), "utf8"),
  ).resolves.toContain("Package: libc6");
  await expect(
    readFile(join(runtimeRoot, "var/lib/dpkg/status.d/ca-certificates"), "utf8"),
  ).resolves.toContain("Package: ca-certificates");
  await expect(
    readFile(join(runtimeRoot, "var/lib/dpkg/status.d/base-files"), "utf8"),
  ).resolves.toContain("Package: base-files");
  await expect(
    readFile(join(runtimeRoot, "var/lib/dpkg/status.d/libc-bin"), "utf8"),
  ).resolves.toContain("Package: libc-bin");
  await expect(readFile(join(runtimeRoot, "usr/share/doc/libc6/copyright"), "utf8")).resolves.toBe(
    await readFile("/usr/share/doc/libc6/copyright", "utf8"),
  );
});

it.each([
  ["an unresolved dependency", "missing", "not found"],
  ["an ldd subprocess error", "error", "fixture ldd exploded"],
  ["a dependency without a package owner", "unowned", "no package owns"],
  ["a packaged runtime file without copyright", "no-copyright", "missing copyright"],
])("fails closed on %s", async (_case, mode, message) => {
  const { runtimeRoot, searchRoot, env } = await fixture();
  const result = spawnSync(
    "bash",
    ["scripts/copy-distroless-runtime-deps.sh", runtimeRoot, searchRoot],
    { encoding: "utf8", env: { ...env, LDD_MODE: mode } },
  );

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(message);
});
