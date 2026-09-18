// Reviewed NVD vendor/product identities; evidence and coverage limits are in
// docs/research/2026-09-18-native-runtime-security-refresh.md.
const identities = new Map([
  ["mozjpeg", "mozilla:mozjpeg"],
  ["libwebp", "webmproject:libwebp"],
  ["expat", "libexpat_project:libexpat"],
  ["util-linux", "kernel:util-linux"],
  ["libvips", "libvips:libvips"],
  ["qpdf", "qpdf_project:qpdf"],
]);

export function nativeCpe(name, version) {
  const identity = identities.get(name);
  if (identity === undefined) return undefined;
  // Current locked sources use numeric release versions, not CPE wildcards or prereleases.
  if (
    typeof version !== "string" ||
    version !== version.trim() ||
    !/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(version)
  )
    throw new TypeError("native advisory version must be an exact numeric release");
  return `cpe:2.3:a:${identity}:${version}:*:*:*:*:*:*:*`;
}
