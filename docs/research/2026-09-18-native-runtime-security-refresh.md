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
