# Processing deployment

Image and PDF processing use separate queues, DLQs, and containers. PDF accepts 1 byte–50MiB and 1–100
pages, runs at most two qpdf candidates within 45 seconds, 768MiB RSS, 256MiB workspace, and 50MiB output,
then returns only an at-least-1%-smaller verified PDF.

qpdf 12.4.0 is Apache-2.0. It recompresses streams and eligible JPEG objects but does not perform DPI-aware
image downsampling and does not always reduce a PDF. `pdf-quality-benchmark.yml` generates all 17 strata,
runs three bounded repeats, and emits sanitized benchmark and release-gate JSON. The measured evidence in
`pdf-engine-benchmark.json` records derived repeat evidence and safe hostile rejection truthfully.

Before candidate processing, qpdf structurally discovers every Flate/filter-chain stream and decodes each
through a bounded process output. The aggregate ceiling is the smaller of 100 MiB and the larger of 16 MiB
or 200 times the input size. Introspection/decode failures fail closed; only an observed output-limit event
is classified as `INPUT_LIMIT_EXCEEDED`. Encrypted input is rejected without exposing feature detail.

The current corpus selected `image-optimized` output for the 1,200×1,600 synthetic JPEG-heavy fixture in
all three native repeats: 2,833,489 bytes became 447,013 bytes, with semantic and bounded PDF.js pixel
verification passing each time. The benchmark therefore records `visualProfilesMeasured: 3` and
`publicAdmissionReady: true`; this is local Node evidence, not hosted browser admission evidence.

The release authority must bind the exact benchmark, cost input, source SHA, Worker artifact, both immutable
engine digests, and nine hosted browser visual measurements. Keep PDF public admission local until those
checks plus staging canary, deletion, cost, and rollback evidence pass.
Rollback restores the Worker and both engine digests together; image processing remains unchanged.
