# Official image runtime migration

The image engine now builds native libraries against the pinned Ubuntu 24.04 LTS snapshot
`20260918T000000Z` and assembles a shell-free runtime from those same official packages.
No private glibc patch or Debian/Ubuntu system-library mixture is used. Node 24.21.0 is retained
from its pinned official distribution; the existing Node 24.13.0 build toolchain is unchanged.
The image and platform digests are in `apps/image-engine/base-images.lock.json`.

## Remediation and remaining findings

- Runtime `libc6 2.39-0ubuntu8.9` includes the official fixes for
  [CVE-2026-19499](https://ubuntu.com/security/CVE-2026-19499) and
  [CVE-2026-5435](https://ubuntu.com/security/CVE-2026-5435).
- `zlib1g 1:1.3.dfsg-3.1ubuntu2.2` still has
  [CVE-2026-85091](https://ubuntu.com/security/CVE-2026-85091), classified Medium by the Ubuntu
  feed in the actual Grype scan. It remains below the unchanged HIGH/CRITICAL release threshold.
  No exception is added, and no claim of source non-applicability or unreachable code is made.
  Ubuntu's notes contradict the earlier blanket source-not-affected conclusion in the September 18
  research: they report a reproducer affecting older versions too. That earlier conclusion must not
  be reused as a release disposition.
- The remaining HIGH result is `libvips 8.18.6 / CVE-2026-2913`. Its locked revision contains
  upstream fix `a56feecbe9ed66521d9647ec9fbcd2546eccd7ee`. The existing harmless custom-source
  probe passes on the newly built runtime. CI now repeats the probe against the exact production
  image before its vulnerability gate. Any applicability exception must bind that CI image's exact
  config digest, preserve the original scanner results, and include the actual approval permalink
  and an expiry of at most 30 days. The migration itself does not grant that exception.

## Verification

The local candidate build succeeded. JPEG, PNG and WebP runtime self-tests passed with network
disabled, a read-only filesystem and dropped capabilities. Checks also confirmed UID 10001,
Node 24.21.0, the patched Ubuntu libc package, no shell/package manager, and package identities and
copyright notices for the copied CA bundle, locale and distribution files. The libvips probe returned
`smallSourceMapped:true` and `oversizedSourceRejectedBeforeRead:true` under a 128 MiB limit.

Lint and all ten package typechecks passed. The final local unit suite passed 185 files / 2,456 tests,
including five dependency-copy regressions. These checks are not a claim of production deployment
or complete security: authoritative CI, the full native quality gate, staging, production canary and
public-admission checks must still complete against the committed artifact.
