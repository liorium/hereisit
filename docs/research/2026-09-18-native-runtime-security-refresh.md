# Native runtime refresh — 2026-09-18

## Scope and status

Local candidate builds only; no push, production deployment, admission override, or exception renewal.
The production preflight [35352668117](https://github.com/liorium/hereisit/actions/runs/35352668117)
still needs protected-environment approval. Successful local checks do not establish live availability.

Both engines now pin the Debian snapshot to `20260918T000000Z` and the distroless runtime to
`sha256:b1fc33242cc74151f50c62b4a03d48afd759dccf81279b5f8e401db4546479c1`.
The source codecs, qpdf version, processing contracts, and public policy are unchanged.

Dockerfile-specific ignore files previously overrode the root rules without excluding `.artifacts`,
`.wrangler`, or the digest-bound vulnerability exception document. Both overrides now exclude these
inputs. The regression test failed for both overrides before the fix and passes for all three ignore files.

## Verified candidate artifacts

- PDF: `sha256:6f49b29959511b0b9798df292108cef6addc4b6bf12b89f67d0343303c46afcd`.
- Image: `sha256:ea5c3dc90f3b184e32bba4cca808ed0a836bd795e30b2c2709048a8a329b39a7`.
- Both container self-tests pass with a read-only filesystem, no external network, dropped capabilities,
  and non-root UID. PDF remains qpdf 12.4.0; image remains Sharp 0.35.3 / libvips 8.18.4.
- PDF benchmark: 17 strata, 51 measurements, 7 native wins, 3 safely rejected hostile strata,
  maximum measured RSS 682020864 bytes. Structural/visual benchmark gate passes and is checked against
  the exact candidate image digest. Its `publicAdmissionReady` field is only this benchmark's verdict,
  not the deployment cost, deletion, rollback, or live admission verdict.
- PDF benchmark SHA-256: `0251f301558f62fd02d29bc7f452aba99895b1feb0308c0f86d0261bded8dcbc`.
  Standard-font warnings occurred during the benchmark. No local Playwright browsers were run.
- Image fuzz: seed 20260716, 60 seconds, 101 cases; 8 successes, 11 pixel-limit rejections,
  82 unsupported-input rejections; harness exited successfully. This is not a competitor performance claim.
- Changed-file Biome checks and the three ignore regression cases pass. The previously reproduced
  four expired-exception test failures remain unresolved; exceptions were not extended or removed.

## Security evidence and remaining work

Trivy 0.69.3 uses the existing pinned scanner image and database digest
`sha256:a7ffe61d3e6eee0a8adab7ee8b3d947774a538bc83d8b5b3eeabcd3a1dff3109`.
Syft 1.44.0 generated CycloneDX SBOMs with 1297 PDF and 1349 image components.
Diagnostic reports, archives, benchmark inputs, and scanner cache remain under
`.artifacts/security-refresh-20260918/` for the active follow-up investigation. They are not release receipts.

| Candidate | Critical | High | Medium | Low |
| --- | ---: | ---: | ---: | ---: |
| PDF | 0 | 0 | 13 | 7 |
| Image | 0 | 12 | 17 | 13 |

PDF's final OS OpenSSL package is `3.5.7-1~deb13u2`; Node reports v24.21.0 / bundled OpenSSL 3.5.8.
The old OpenSSL and GLib exceptions' findings are absent from these scans. This does not mean no other
vulnerabilities exist. Image's blocking findings are:

- `libblkid1` and `libmount1`, each with CVE-2026-76642, CVE-2026-78408, CVE-2026-78409,
  and CVE-2026-78410 (eight package findings).
- `libexpat1`: CVE-2026-66046, CVE-2026-76956, CVE-2026-76957 (three findings).
- Sharp: GHSA-rgj7-g3m4-5g8c (one finding).

The [Sharp advisory](https://github.com/lovell/sharp/security/advisories/GHSA-rgj7-g3m4-5g8c)
concerns libheif. This custom runtime reports no libheif version and disables HEIF file, buffer, and
stream input. Do not infer a reachable exploit solely from the package finding, or silently waive it.
[Sharp 0.35.4's package metadata](https://github.com/lovell/sharp/blob/v0.35.4/package.json)
requires libvips >=8.18.6, so a patch upgrade must update and validate the paired native source too.
Expat is a mandatory dependency in the currently pinned libvips build, not an optional loader that can
simply be removed. Resolve or explicitly review the remaining exact-image findings before release.

Next: verify upstream fixes for the remaining packages, perform compatible source/package upgrades,
rebuild and rescan the resulting exact artifacts, then rerun quality checks and release gates. Keep the
existing admission and security gates in force; do not renew exceptions merely to obtain a passing CI run.

## Paired Sharp/libvips follow-up

Sharp is now pinned to 0.35.4 and the custom libvips source to 8.18.6, revision
`426af3f44246fce9cfa8dd51a353aa4dfd48c553`. The source LICENSE SHA-256 is unchanged:
`dc626520dcd53a22f727af3ee42c770e56c97a64fe3adb063799d8ab032fe551`.
This does not substitute for a new exact-source commercial release review.

- New local image: `sha256:fdc5481233dfcd2776a8deec46a45746103fb9385e4e41106b69597eda2c43e8`.
- Read-only, network-disabled, non-root container self-test passes: Sharp 0.35.4, libvips 8.18.6,
  ten required artifacts. Direct runtime assertions confirm HEIF input is disabled and no prebuilt
  `@img/sharp-*` package is present in the deployed dependency tree.
- Fuzz: seed 20260716, 60 seconds, 107 cases; nine successes, twelve pixel-limit rejections,
  86 unsupported-input rejections. The harness exits successfully and removes its test container.
- With the same pinned Trivy database: Critical 0 / High 11 / Medium 17 / Low 13.
  GHSA-rgj7-g3m4-5g8c is absent; the eleven OS package findings listed above remain.
  Syft reports 1349 components, including Sharp 0.35.4.
- Regenerated public notices cover 46 packages; SHA-256
  `aa4f525af1b9597f192dd31b409681f00be40b463522f5b3d8f97e99c4a82949`.
  Both old and new prebuilt libvips versions remain prohibited in application SBOMs.
- Focused self-test and application supply-chain tests: 27 passed. Image-engine suite and native
  policy tests: 191 passed, four existing expired-exception failures. Lint: 643 files passed.
  Type checks: all twelve packages passed.
- Full unit run: 3243 passed / 7 failed (3250 total). Four failures are the expired exceptions;
  three are timeouts during concurrent native compilation. After compilation and type checks finish,
  the affected two test files pass all 61 tests without changing their timeout limits.
- Evidence is retained under `.artifacts/sharp-refresh-20260918/` for follow-up, not as release receipts.
  No deployment, admission override, or exception renewal was performed.

The production dependency audit also reports two Critical Next.js advisories requiring >=16.3.3:
[Windows-hosted RCE](https://github.com/vercel/next.js/security/advisories/GHSA-p293-qw3h-jr36)
and [AVIF image optimization](https://github.com/vercel/next.js/security/advisories/GHSA-2xp9-vwfh-vxw4).
This site's `output: "export"` configuration does not deploy the Next.js server or Image Optimization
API; that narrows runtime exposure but does not make the dependency audit pass. Upgrade Next.js and
rerun static build/export and dependency checks before release.

For the remaining OS findings, Debian currently lists Expat 2.8.4 fixes in unstable, while the pinned
Trixie package remains vulnerable: [attribute processing](https://security-tracker.debian.org/tracker/CVE-2026-66046),
[hash flooding](https://security-tracker.debian.org/tracker/CVE-2026-76956), and
[custom encoding callbacks](https://security-tracker.debian.org/tracker/CVE-2026-76957).
The [util-linux restricted mount issue](https://security-tracker.debian.org/tracker/CVE-2026-78410)
also remains unfixed in that Trixie package. Do not mix unstable packages into the runtime or silently
waive findings; review a reproducible compatible patch or exact-image applicability next.

## Next.js dependency follow-up

The web app now pins [Next.js 16.3.5](https://github.com/vercel/next.js/releases/tag/v16.3.5),
including matching env/SWC packages. React and the static-export configuration are unchanged.
The generated Next.js root-params type import and bundled-documentation agent pointers are retained.

- Before the update, `pnpm audit --prod --audit-level moderate` reported the two Critical Next.js
  advisories above. Afterward it exits successfully with no known vulnerabilities. This npm audit
  does not clear the eleven native OS package findings.
- Web, header, and application supply-chain tests: 20 files / 156 tests passed.
- Web production builds pass both without an API override and with
  `NEXT_PUBLIC_PROCESSING_API_ORIGIN=https://api.hereisit.app`: 31 static pages generated;
  static export, discovery import boundaries, and bundle budgets pass for both builds.
- Local `next dev` HTTP smoke: `/`, `/tools`, `/image/compress`, and `/pdf/compress` return 200
  HTML containing the site identity. The development server is stopped afterward. This does not
  establish browser interaction correctness; no local Playwright browser was run.
- The aggregate `pnpm build` attempt stops because its Worker dry-run requires the absent local
  `hereisit-image-engine:test` tag. Web checks were then run separately; aggregate verification is
  not claimed. Existing expired-exception failures and hosted release checks remain unresolved.
- Notices still cover 46 packages; regenerated SHA-256:
  `bf56e991e52df407445a633f3eab43817c4e040e8a90fc018e7451e1781b695f`.
  No push, deployment, admission override, or security exception change was made.

## Expat source-patch follow-up

The image engine now builds [Expat 2.8.4](https://github.com/libexpat/libexpat/releases/tag/R_2_8_4)
from revision `12cf0b1f25f026a022fe728ad8f7e3d017285b80`, using the existing native source,
license-notice, and artifact-hash pipeline. It does not mix Debian unstable binaries into the runtime.
The source lock explicitly leaves exact-source commercial review pending.

- New local image: `sha256:ba43bce9ed9a4188786a1e087e0479ff433531eb5a9fe01ea6d76a87d193dd3c`.
- Upstream CTest: one registered test suite passed; the build checks both pkg-config version 2.8.4
  and the actual library's `XML_ExpatVersion()` return value. libvips configuration selects Expat 2.8.4.
- The hardened container self-test passes with eleven required artifacts. Loading Sharp and inspecting
  the process memory map confirms `/usr/local/lib/libexpat.so.1.12.4` is the loaded Expat library.
  Its SHA-256 `2ffa7f8d567dbf567d28ee3f4567e3db67515cae0b33096a4a7df17604199d45`
  matches the pinned source build record. The old Debian libexpat1 package record is absent.
- The actual runtime inventory passes source revision, notice, package-license, and artifact-hash
  validation. This is not the separate exact-source commercial release approval.
- Fuzz: seed 20260716, 60 seconds, 103 cases; nine successes, eleven pixel-limit rejections,
  83 unsupported-input rejections. The test container was removed by the harness.
- Same pinned Trivy/database: Critical 0, High 8, Medium 16, Low 13. The eight util-linux package
  findings listed above remain blocking; no new exception was added for them.
- Syft reports 1346 components but does **not** catalog the source-built Expat library. Therefore
  disappearance of Expat package findings is not, by itself, proof of remediation or complete native
  vulnerability coverage. The upstream patch, tested runtime version, and loaded-binary/source hash
  checks supply the specific patch evidence. Native-source scanner coverage remains follow-up work.
- All ten historical exception entries' CVEs are absent from the corresponding exact refreshed
  image/PDF scans. PDF scan image identity was rechecked against its retained candidate. Those expired,
  obsolete entries were removed rather than renewed; the exception document is now empty. Old image
  findings are no longer waived. The checked-in exception test now uses current time instead of an
  August timestamp; synthetic expiry and validity-window rejection tests remain.
- Build log, runtime inventory, loaded-library proof, archive, scans, and fuzz output are retained in
  `.artifacts/expat-refresh-20260918/` for active verification, not as deployment receipts.
- Full unit suite, run after native/fuzz work with one worker: 223 files / 3251 tests passed in
  230.68 seconds. Image-engine type checking and shell syntax checks passed. Independent read-only
  patch review found no actionable defects; it is not external release or commercial approval.

No push, deployment, or public-admission override was performed. Remaining util-linux findings,
native-source catalog coverage, exact-source release review, and hosted release evidence still need work.

## util-linux stable-branch follow-up

The image engine replaces Debian's libblkid/libmount runtime libraries with source-built shared
libraries from the same upstream 2.41 stable line. The pinned revision is
`ba905a1874959c70fd706aa7d49df61076864e0a` (2026-09-08); its reported upstream version remains 2.41.6.
This is a post-release stable-branch snapshot, **not** the unchanged v2.41.6 release tag.

The initial release-tag build exposed a missing `fileutils.h` include in `hook_idmap.c`.
Investigation also found the [upstream symlink-protection flag correction](https://kernel.googlesource.com/pub/scm/utils/util-linux/util-linux/+/20361d66df4d3f32d5e137fe61a55cdf156c91f0):
the old fallback used `0x02` (magic links) instead of `0x04` (all symlinks). The pinned stable revision
includes both corrections without local source patches. Its changes relative to the release tag were
reviewed: eight files, 31 insertions, 15 deletions. The [2.41.6 release notes](https://github.com/util-linux/util-linux/blob/v2.41.6/Documentation/releases/v2.41.6-ReleaseNotes)
and [restricted-source advisory](https://github.com/util-linux/util-linux/security/advisories/GHSA-rh77-686x-2f2m)
describe the security updates; [CVE-2026-78409's upstream advisory](https://github.com/util-linux/util-linux/security/advisories/GHSA-8f2p-47x3-43mv)
lists the affected line as >=2.42, unlike the Debian package-level finding against 2.41.5.

- Bison/flex are build-only requirements of upstream Meson configuration, even with optional features
  disabled. They are not added to the runtime image.
- Native COPY/RUN steps are split by library so a util-linux adjustment reuses completed JPEG, WebP,
  and Expat builds. The corrected-build log confirms those cache hits.
- Review found that upstream `build-libblkid` also enables the `blkid` executable. Explicit Ninja
  shared-library targets and exact library/header/pkg-config installation now avoid installing it.
  Guards still reject any installed `bin` or `sbin` directory. Only `.so` files enter the runtime.
- Copyright-bearing `lib/crc64.c` and `lib/xxhash.c` notices are copied in addition to the license texts
  and included in the source lock. Exact-source commercial review remains pending; no approval or
  vulnerability exception was created.

Verified local candidate:

- Image ID: `sha256:41dfccc2d26b15a68c0dcf2f49bf3819587fb70ecef10baf48d7f35434257cd3`.
- Read-only, network-disabled, non-root self-test: Sharp 0.35.4 / libvips 8.18.6 / thirteen artifacts.
- The Sharp process maps only `/usr/local/lib/libblkid.so.1.1.0` and
  `/usr/local/lib/libmount.so.1.1.0` for these libraries. Their respective SHA-256 values,
  `c1b9d1a63fd6dbfb4c2d3f680b30a3571d16476c5d01670493113cace0d0b4dc` and
  `82abe9e323097866d4d874a2f6d2d6125e0893496dea0f189e16814b93c2b69d`, match the pinned source's
  build record. Actual runtime inventory passes source revision, notice, and hash validation.
- The old Debian libblkid1/libmount1 package records are absent. Runtime binary paths contain none
  of blkid, mount, umount, nsenter, unshare, bison, or flex.
- Same pinned Trivy/database: Critical 0, High 0, Medium 14, Low 11; image identity is checked against
  the actual Docker image. Syft reports 1337 components but does not catalog the new source-built
  libraries. **Zero detected High/Critical findings does not establish complete native coverage.**
  The source revision and loaded-binary proofs support this particular patch; automated native
  vulnerability matching remains incomplete.
- Image-engine and native license-policy tests: 24 files / 198 tests passed. This is focused regression
  verification, not a fresh aggregate `pnpm verify` run. Independent review's build/notice findings were
  fixed and re-reviewed; that does not grant external commercial approval.
- Fuzz: seed 20260716, 60 seconds, 108 cases; ten successes, twelve pixel-limit rejections,
  86 unsupported-input rejections. The harness removed its test container afterward. Image-engine
  type checking and repository lint (643 files) passed. No local browser testing was run.
- Production preflight `35352668117` was checked again and remains `waiting`; it was not approved.
  No push, deployment, or admission override was performed.

### Native scanner coverage investigation

The existing [Syft ELF package-note cataloger](https://oss.anchore.com/docs/capabilities/binary/)
recognizes Expat 2.8.4 when a `.note.package` section containing its real name, version, MIT license,
and generic package URL is added to a **separate diagnostic copy** of the library. This was tested
with the pinned Syft image, not by editing a scanner's output or inventing Debian package metadata.
The copy was never installed into a production candidate.

The pinned Trivy filesystem scanner still reports zero language packages and an empty result for that
annotated-library directory. Therefore ELF notes alone improve cataloging but do not establish native
vulnerability coverage. Integrating artifact-bound native identities and an applicable vulnerability
matching path remains required before claiming complete security verification. Diagnostic inputs and
outputs are retained under `.artifacts/util-linux-refresh-20260918/` for this active follow-up.

### Embedded native inventory and CI coverage guard

The image build now creates `/build-metadata/native.cdx.json` from the pinned source lock and the
actual assembled runtime. It reuses the license gate's artifact map, resolves runtime symlinks, and
requires each file's SHA-256 and build-time path to match the exact source revision's build record.
Benchmark-only sources are excluded. Quantizr's occurrence is the `png-smart` wrapper that contains
it; the wrapper's digest is recorded as runtime evidence, not as a standalone quantizr package hash.

CI enables Syft's existing [embedded SBOM cataloger](https://oss.anchore.com/docs/capabilities/sbom/)
for the image engine only, preserving other scopes and default catalogers. The existing application
supply-chain gate now requires every production native source's exact version, revision-bearing
reference, cataloger, and embedded inventory location. Missing or miswired coverage fails the gate;
scanner output is not supplemented with invented package records after scanning.

Initial verified inventory candidate:

- Image ID: `sha256:ce4889b4c0f2237e1072dded57780fe8c3b6912088722a7fb41f31c912f01157`.
- Pinned Syft: 1345 components, including all seven locked production native sources. The actual
  scanner result passes the new coverage guard. Runtime inventory passes the existing license checks.
- All twelve required native artifact hashes are identical to the preceding util-linux candidate.
  Read-only, network-disabled self-test passes: Sharp 0.35.4 / libvips 8.18.6 / thirteen artifacts.
- Pinned Trivy/database: Critical 0, High 0, Medium 14, Low 11. Results still contain only Debian,
  Node, and the two Cargo lockfile scopes. The new C/C++ identities are **not** evidence that Trivy
  matched their vulnerabilities. Syft-generated CPE guesses also need independent validation before
  being used as proof of vulnerability coverage.
- Focused generation, coverage, license, and normalization regression tests: four files / 77 tests
  passed with the standard timeout. Repository lint (645 files) and all twelve type checks passed.
- Independent read-only review found no blocking defect. Its concurrent focused run hit an existing
  five-second inventory timeout; a reviewer-only extended-timeout run is not the final acceptance run.
- The first full unit run passed 3265 tests and timed out in one multi-case supply-chain test while
  another review test process overlapped. A fresh, isolated `pnpm exec vitest run --maxWorkers=1`
  then passed all 224 files / 3266 tests in 208.90 seconds, with the original five-second timeout.
  The timed-out run's leftover temporary fixture was removed. No timeout or acceptance rule changed.
- Final rebuild after the review and coverage-gate changes produced the **same image ID** above.
  Its fresh read-only self-test, runtime inventory comparison, and actual-image PR license gate all
  pass. The retained raw scans therefore still bind to the final runtime artifact; the redundant final
  archive was removed. This PR license result does not replace exact-source commercial release review.

This closes the image source inventory omission, not the native vulnerability matching gap. PDF native
inventory and appropriate native advisory matching remain follow-up work. Evidence is retained under
`.artifacts/native-sbom-20260918/`; no push, deployment, approval, or exception renewal was performed.

### PDF native inventory follow-up

PDF now embeds the same inventory path and uses the shared application coverage guard. The qpdf
source archive checksum is validated by the build, retained with its installation, and compared with
the runtime source lock. Both shipped binaries must match the verified build byte-for-byte before
their hashes enter the inventory. The generator reuses existing bounded reads and atomic writes.
The Node interpreter used for generation stays in the builder, not the final runtime.

- Initial real build exposed an incorrect development-library alias in the generator and fixture.
  The corrected fixture failed before the fix; both now use the installed SONAME `libqpdf.so.30`
  pointing to `libqpdf.so.30.4.0`. The corrected container build succeeds.
- PDF image ID: `sha256:2d4216f00e00e60bf8a55b93968d3002536194b236248e1efe99c811f873131e`.
- Read-only, network-disabled self-test passes: qpdf 12.4.0, UID 10001, seven required artifacts.
  Direct runtime checks verify both recorded binary hashes and absence of `/usr/local/bin/node`.
  Both native binary hashes are unchanged from the earlier `security-20260918` PDF candidate.
- Pinned Syft with the embedded cataloger reports 1299 components including the exact qpdf source
  archive identity. Both the new PDF SBOM and retained image SBOM pass the shared native coverage guard.
- Same pinned Trivy/database: Critical 0, High 0, Medium 13, Low 7. The normalizer checks the actual
  PDF image ID before binding both reports. This still does not establish native advisory coverage.
- Focused generation, license-policy, and supply-chain regression tests: four files / 55 tests pass.
  Independent read-only re-review confirms the build blocker is resolved with no remaining important
  findings. Evidence remains in `.artifacts/pdf-native-sbom-20260918/`, not release receipts.
- A fixture cleanup initially read the image license from the PDF-only singular field, causing sixteen
  supply-chain test failures. The fixture now uses each source's real license field. A fresh isolated
  full run passes all 225 files / 3278 tests in 203.43 seconds with unchanged timeout limits.
  Repository lint passes 647 files; all twelve package type checks pass. Aggregate `pnpm verify`,
  hosted browser tests, and deployment are not claimed by these local checks.

### Native vulnerability matcher diagnostic

A separate [Grype 0.119.0](https://github.com/anchore/grype/releases/tag/v0.119.0) diagnostic uses image
`sha256:8c2c9234a345577a6d321a4753aa3ee1276d8975c8452d2344a56b57733ecad3`, with database built
`2026-09-18T06:30:15Z` (archive SHA-256
`5776a9b7190b6e6eccdb47023eb1cb7bffcfc4cb9ed2b11d777484a577ca3336`). It scans the retained image
candidate's original Syft report. This is not integrated into the release gate or converted into
fabricated Trivy records. Original reports and clearly labelled synthetic controls are retained in
`.artifacts/native-vulnerability-20260918/`.
The local database file SHA-256 is `79f96f4a536f6e8d9f7d3c2c46ca5fe23513aa88692b913bddf3283b8016cc05`.

The diagnostic reports 26 matches, including four High findings: zlib CVE-2026-85091, glibc
CVE-2026-19499/CVE-2026-5435, and native libvips CVE-2026-2913. These conflict with the earlier
Trivy severity totals and require per-finding applicability review, not automatic acceptance or waiver.
The [Debian glibc entries](https://security-tracker.debian.org/tracker/CVE-2026-19499)
[describe minor, no-DSA issues](https://security-tracker.debian.org/tracker/CVE-2026-5435), while the
[zlib tracker](https://security-tracker.debian.org/tracker/CVE-2026-85091) still marks Trixie vulnerable.
For libvips, the locked revision's `vips_source_read_to_memory` already has the length check from the
[referenced upstream fix](https://github.com/libvips/libvips/commit/a56feecbe9ed66521d9647ec9fbcd2546eccd7ee).
GitHub's comparison also confirms the fix is an ancestor of the locked revision (129 ahead, zero behind).
That is evidence against the broad version-only match, not a completed runtime applicability review.

Positive control: synthetic libwebp 1.3.0 metadata with the
[NVD vendor identity](https://nvd.nist.gov/vuln/detail/cve-2023-4863)
`webmproject:libwebp` detects CVE-2023-4863; the same control with Syft's guessed `libwebp:libwebp`
identity detects zero findings. Both use the same cached database with networking disabled.
Thus adding generic package names alone demonstrably misses known vulnerabilities. Validate native
advisory identities and bind matcher/database evidence through the existing release contracts before
claiming complete automated coverage. No new exception, deployment, or public admission was approved.

### Reviewed native advisory identities

The embedded inventories now carry explicit CPE vendor/product identities for the six reviewed
C/C++ sources below. Their exact numeric release version comes from the already-validated source lock;
wildcards, delimiters, and whitespace are rejected. The shared application gate requires the matching
CPE in the actual Syft output, so losing the identity during scanning fails instead of silently passing.
This does not change the generic package URL, source revision, binary hash, or vulnerability severity.

| Source | CPE vendor/product | Identity evidence |
| --- | --- | --- |
| mozjpeg | `mozilla:mozjpeg` | [FreeBSD upstream port update](https://lists.freebsd.org/archives/dev-commits-ports-all/2022-August/036313.html) |
| libwebp | `webmproject:libwebp` | [NVD CVE-2023-4863](https://nvd.nist.gov/vuln/detail/cve-2023-4863) |
| Expat | `libexpat_project:libexpat` | [NVD CPE record](https://nvd.nist.gov/products/cpe/detail/1642963) |
| util-linux | `kernel:util-linux` | [Syft upstream binary identity](https://oss.anchore.com/docs/capabilities/binary/) |
| libvips | `libvips:libvips` | [NVD CPE record](https://nvd.nist.gov/products/cpe/detail/1AC7308F-4591-41F0-909F-730F9AB846B0) |
| qpdf | `qpdf_project:qpdf` | [NVD CVE-2017-11624](https://nvd.nist.gov/vuln/detail/CVE-2017-11624) |

The generator deliberately does not invent CPEs for oxipng or quantizr. Their Rust dependency
lockfile scanning remains separate; a guessed identity is not proof of native advisory coverage.
New or prerelease versions need explicit identity/encoding review rather than permissive string
interpolation. Version-only matching can still over-report patched stable revisions and miss advisories
without appropriate CPE data. Grype release-gate integration, exact artifact/database binding, and
finding applicability review remain required. No release exception is introduced by these identities.

Verified identity candidates:

- Image ID: `sha256:64eef9fc6b74a8e76e7c59976b813af84bc33b76ad083b92dc0c3b3fa0b8e6b3`.
- PDF ID: `sha256:09e0aafdb098c92238d1ec6e0bcb73e1ce3f1026ff11b11ef78c4919936e3167`.
- Both read-only, network-disabled, non-root self-tests pass. The twelve image native hashes and two
  PDF native hashes match the preceding inventory candidates; all are checked against actual bytes.
- Pinned Syft retains five explicit image CPEs and one PDF CPE (1345 / 1299 total components).
  Both actual reports pass the shared coverage guard. All twelve deletion/replacement mutations of
  those six identities are rejected. Raw scanner reports remain untouched; normalization binds them
  to the exact Docker image IDs above.
- With the same pinned Trivy database: image C0/H0/M14/L11; PDF C0/H0/M13/L7. The separate Grype
  diagnostic, using the same database as the preceding experiment, reports 28 image matches and
  20 PDF matches. High findings remain four for image and three for PDF; no exceptions were added.
  Corrected util-linux identity additionally exposes Medium CVE-2026-3184 and CVE-2026-13595 matches
  previously missed by the guessed vendor. Their exact-revision/runtime applicability remains open.
- The synthetic libwebp positive control also detects CVE-2023-4863 **after** passing through Syft's
  embedded cataloger and into Grype, proving the corrected identity survives both scanner boundaries.
- Initial regression run fails fourteen relevant cases before implementation; the corrected four-file
  suite passes 63 tests. Final verification including both license gates and report normalization
  passes seven files / 107 tests. Independent read-only review finds no important defect; the actual
  six-identity mutation checks above address its suggested extra verification. Lint passes 649 files;
  all twelve package type checks pass. This is focused verification, not a new aggregate `pnpm verify`.
- Build logs, raw/normalized scans, mutation proof, runtime hash comparisons, and diagnostic controls
  are retained in `.artifacts/native-identities-20260918/` for active follow-up. No deployment or approval.
