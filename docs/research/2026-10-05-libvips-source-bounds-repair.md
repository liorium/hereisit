# libvips source boundary repair

This is local remediation evidence, not a vulnerability exception or release approval.

## What the expanded check found

The [original fix](https://github.com/libvips/libvips/commit/a56feecbe9ed66521d9647ec9fbcd2546eccd7ee)
checks both `vips_source_read_to_memory` and `vips_source_sniff_at_most` before GLib's 32-bit array
length can truncate a larger value. The later [upstream change](https://github.com/libvips/libvips/commit/7fe60225cb62f93963b9e846bfb09eb382e5e195)
replaces the sniff check with `g_assert(length <= UINT_MAX)` and documents a caller precondition.
That assertion does not protect our release binary.

On the existing local runtime `sha256:1507b65b594cddb1761d9f99092412ceea842c2b630330e72ac8d2d7deedc0b4`,
the old map probe passed, but the added oversized sniff test reached the read callback and failed.
The synthetic callback supplies at most four bytes; the check uses no real user file or oversized
allocation. This demonstrates missing runtime rejection, not remote exploitability through the service.

## Bounded repair and provenance

`apps/image-engine/native/libvips-source-bounds.patch` restores the original sniff error return.
The upstream version remains `8.18.7`, revision `24ad4d042940e6bf99a68871ba886ca8847c9c82`.
Patch SHA-256 is `871f811400dbb8cdc6a175245da0a9a5ff53acf1cb231f9aaded862e81d0f90d`.
The build checks this hash, applies the patch without fuzz, records it in native build metadata,
and retains the patch under runtime licenses. The source lock, runtime inventory validation and
embedded SBOM also bind that hash; missing, different or altered patch evidence fails.

The rebuilt local image `sha256:218c165c20730f1b743465d1604ed94395fbd1dd43f87dc9aa8bb455daad8750`
contains `/usr/local/lib/libvips.so.42.20.7` with SHA-256
`8ee53696d97335590640753b119a9be015cb9a89827fe82f080535d36039863c`.
The same C probe now passes four checks: small mapping, oversized mapping rejected before reading,
small sniffing, and oversized sniffing rejected before reading. Both invalid paths must return an
error; aborting is not accepted. The exact runtime inventory/license gate passes as well.

Five focused suites pass 72 tests, including patch-byte drift, missing build provenance, wrong
runtime/source identities and incomplete probe results. Native fuzz passes 216 cases in 60 seconds:
24 pixel-limit rejections, 176 unsupported-input rejections and 16 successful operations. No local
Playwright run was performed.

## Remaining release evidence and approval

These local Docker hashes are not normalized CI release hashes. CI runs the strengthened probe
against its immutable image config digest and records the library hash, locked source/version/patch,
probe source/binary hashes, time and GitHub commit/run/attempt. Its diagnostic collector does not
change vulnerability acceptance. The exact committed, timestamp-normalized CI image still needs
fresh scanner evidence and the existing release checks.

The raw HIGH result and vulnerability gate remain unchanged; both exception files remain empty.
If scanner applicability still requires a reviewed exception after the actual repair, the existing
mechanism requires the exact CI config digest, CVE/package/version, exploitability evidence, owner,
real approval permalink and expiry no more than 30 days away. No approval is inferred here.
The engine exception file is excluded by `.dockerignore`, so recording an approved exact-image
exception does not create an image-digest circular dependency.
