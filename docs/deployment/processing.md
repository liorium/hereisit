# Processing deployment

Image and PDF processing use separate queues, DLQs, and containers. PDF accepts 1 byte–50MiB and 1–100
pages, runs at most two qpdf candidates within 45 seconds, 768MiB RSS, 256MiB workspace, and 50MiB output,
then returns only an at-least-1%-smaller verified PDF.

qpdf 12.4.0 is Apache-2.0. It recompresses streams and eligible JPEG objects but does not perform DPI-aware
image downsampling and does not always reduce a PDF. `pdf-quality-benchmark.yml` generates all 17 strata,
runs three bounded repeats, and emits sanitized benchmark and release-gate JSON. The measured evidence in
`pdf-engine-benchmark.json` passed with eight structured wins and three safe hostile rejections.

Task 8 must bind the exact benchmark, cost input, source SHA, Worker artifact, and both immutable engine
digests. Keep PDF public admission local until staging canary, deletion, cost, and rollback evidence pass.
Rollback restores the Worker and both engine digests together; image processing remains unchanged.
