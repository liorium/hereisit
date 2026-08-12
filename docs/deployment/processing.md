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

The current corpus selected only structural qpdf outputs, so `visualProfilesMeasured` is zero and
`publicAdmissionReady` is false. The bounded image-optimized PDF.js pixel path exists but is not claimed as
measured coverage; Task 8 browser admission must exercise it before public rollout.

Task 8 must bind the exact benchmark, cost input, source SHA, Worker artifact, and both immutable engine
digests. Keep PDF public admission local until staging canary, deletion, cost, and rollback evidence pass.
Rollback restores the Worker and both engine digests together; image processing remains unchanged.
