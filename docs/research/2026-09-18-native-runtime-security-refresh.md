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
