# Production Processing Platform and Image Optimization Design

**Status:** Approved on 2026-07-16

## Summary

HereIsIt's current browser runtime is an MVP: it proves the upload, configuration, progress, batch, and
download experience, but browser-native Canvas encoders cannot provide deterministic, competitive image
compression across browsers and devices. HereIsIt will retain its existing UI, tool registry, versioned
contracts, and browser workers while adding a server-native execution path.

The long-term product goal is feature parity with iLoveIMG and iLovePDF, followed by expansion into
signing, APIs, automation, and additional tool domains. That goal is too large for one specification or
one implementation cycle. The first production project is deliberately limited to:

1. a reusable server job platform;
2. a native JPEG, PNG, and WebP optimization engine;
3. migration of `/image/compress` to that engine behind a reversible feature flag;
4. a quality, performance, cost, deletion, and licensing release gate.

Server processing is the default for image compression. Selecting a file may start an upload without a
separate consent modal or checkbox, but the file picker must state before selection that the file will be
sent to HereIsIt for processing and automatically deleted. This satisfies the product requirement for an
iLove-style flow while preserving the engineering rule that a file never leaves the device without an
explicit UI disclosure.

The architecture is a thin Cloudflare control plane in front of a portable OCI image-processing
container. Browser processing remains available for previews, inexpensive transformations, emergency
fallback, and future privacy-focused modes. Quality is not intentionally degraded for free users;
monetization comes from ads, batch and file limits, priority, automation, API use, and enterprise
controls.

## Context and problem

The current `image.pipeline@1` implementation uses `createImageBitmap`, `OffscreenCanvas`, and
`convertToBlob`. It has useful validation, geometry, naming, progress, cancellation, and worker
boundaries, but its encoder behavior is selected by the browser rather than HereIsIt. In particular:

- JPEG and WebP quality values are implementation-dependent;
- PNG has no professional structural optimizer or palette quantizer;
- the same source can produce different output across browser and operating-system versions;
- decoded images and ZIP results can retain several full-size copies in memory;
- the scheduler bounds worker count but not total decoded pixels or native memory;
- a valid file can be reported as already small even when a dedicated codec could reduce it;
- there is no licensed golden corpus or rate-distortion release gate.

The user has confirmed the problem with real files: competing services can reduce files that HereIsIt
rejects as already optimized. Continuing to tune Canvas quality numbers would not remove the underlying
quality ceiling.

The repository already has the correct foundation for replacement rather than a rewrite:

- product-facing tool IDs are separated from implementation code;
- processing specifications and results are versioned and validated;
- browser work runs behind Worker boundaries;
- pure geometry, naming, validation, and planning logic is tested;
- public routes and workbench UI are already usable.

The design therefore adds executors behind contracts instead of replacing the application.

## Goals

- Make JPG, PNG, and WebP compression competitive with mature commercial web tools.
- Preserve the source format for the compression tool unless the user explicitly chooses conversion.
- Never return a larger file as a compressed result; return the original with an honest explanation.
- Normalize orientation, color, alpha, and metadata according to a documented policy.
- Keep the web UI responsive and show truthful upload, queue, processing, and verification phases.
- Bound file size, decoded pixels, native memory, CPU time, concurrency, and account-wide spend.
- Delete inputs after processing; result deletion is due after a proven download handoff or 30 minutes,
  with a healthy-operation sweeper SLO and explicit exceptional-delay disclosure.
- Keep file bytes, names, thumbnails, and signed URLs out of logs and analytics.
- Make every server engine replaceable without changing the public tool contract.
- Pin codec sources, compiler versions, build flags, license texts, patent notices, and artifact hashes.
- Measure compression, perceptual quality, latency, peak memory, failures, and cost before rollout.
- Reuse the platform for later image, PDF, signing, API, and automation projects.
- Preserve a portable container boundary so HereIsIt is not locked to one compute provider.

## Non-goals

- Implementing all iLoveIMG or iLovePDF features in this project.
- Migrating PDF tools to server processing in this project.
- Adding accounts, subscriptions, payments, paid credits, or a public API.
- Supporting animated GIF, animated WebP, or APNG.
- Encoding HEIC/HEVC.
- Shipping AVIF or JPEG XL output.
- Adding AI upscaling, background removal, face analysis, or learned saliency.
- Building multi-region databases, Kubernetes, or codec-per-tool microservices.
- Promising byte-identical output from browser-native codecs.
- Inventing a new image codec.

## Scope decomposition

The full product is divided into independently specified projects:

1. **Processing foundation and image optimization:** this specification.
2. **Image feature parity:** resize, crop, rotate, convert, watermark, SVG optimization, animation, and
   advanced image tools on the shared image engine.
3. **PDF Core:** merge, split, extract, organize, rotate, crop, watermark, protect, unlock, render, and
   image conversion using a separate document container.
4. **Document Heavy:** analyzed PDF compression, Office conversion, HTML conversion, OCR, PDF/A,
   repair, comparison, redaction, and document intelligence.
5. **HereIsIt Sign:** signature requests, identity, audit trails, certificates, and long-term signatures
   in an isolated security domain.
6. **HereIsIt API and automation:** API keys, credits, webhooks, workflows, teams, and regional
   processing.

Each project receives its own design, plan, verification, and rollout. Feature breadth must not bypass
the quality gate established here.

## Approach decision

### Selected: modular native processing behind shared contracts

The selected architecture keeps a small Cloudflare control plane and one portable native image
container. The existing browser executor and the new server executor implement compatible product
semantics. New tools register declarative manifests and compiled adapters rather than dynamically
loading third-party code.

This approach has more initial structure than a single image endpoint but provides:

- deterministic codec versions and settings;
- native CPU, memory, SIMD, and filesystem access;
- bounded and measurable cost;
- reusable upload, queue, status, download, and deletion behavior;
- a direct path to API and enterprise products;
- independent image, PDF-heavy, and signing security boundaries.

### Rejected: continue improving only the browser runtime

Dedicated WASM codecs could improve the browser path, but mobile memory limits, implementation variance,
large bundles, cross-origin-isolation requirements for threads, and multi-copy buffers create a ceiling
for a server-default, iLove-scale product. The browser executor remains valuable, but it is not the
reference production encoder.

### Rejected: one unrestricted Sharp/Ghostscript service

A single service built from a broad prepackaged image and PDF stack would add features quickly, but it
would mix unrelated failure domains, ship unnecessary parsers, complicate license compliance, and make
per-format quality tuning difficult. Ghostscript, MuPDF, Poppler, and similar broad PDF stacks also
introduce AGPL, GPL, commercial-license, or attack-surface decisions that must not enter the first image
engine accidentally.

## System architecture

~~~text
Browser
  ├─ preview and inexpensive transforms → browser executor
  └─ production compression
       → API Worker
           ├─ validate contract, limits, and estimated cost
           ├─ authenticate and stream an exact-length upload into R2
           ├─ persist job state and usage reservation in D1
           └─ enqueue job ID and object keys
                → image-engine OCI container pool
                    ├─ inspect and classify
                    ├─ decode and normalize
                    ├─ transform
                    ├─ encode candidates
                    ├─ verify
                    └─ stream verified result back to API Worker
                         └─ fixed-length create-only R2 write
                              → authenticated attachment download
                              → explicit deletion and sweeper
~~~

### API Worker

The Worker is a control-plane gateway. It:

- validates versioned JSON requests;
- enforces anonymous-session, file, pixel, concurrency, and daily limits;
- estimates and reserves weighted processing units before upload;
- authenticates an exact-length upload stream and an attachment download;
- creates, reads, cancels, and expires jobs;
- counts upload bytes while streaming to R2 and verifies stored metadata before enqueue;
- enqueues identifiers rather than file bytes;
- returns normalized progress, warning, and error payloads.

The Worker must not buffer or decode an image. Cloudflare Workers have a 128 MB isolate memory limit
that includes WebAssembly allocations, so the Worker is unsuitable for the reference codec engine.

### R2

R2 stores temporary input and result bytes only. The authenticated Worker streams each browser request
through a fixed-length, create-only R2 binding write under a random object key. This adds no whole-file
buffer and allows the control plane to reject a missing, mismatched, or over-limit body before enqueue.
Browser-facing R2 credentials and presigned upload URLs do not exist. Original filenames never become
object keys. A completed upload is accepted only after the control plane verifies the expected object,
size, content type, and job ownership.

R2 does not store job state, thumbnails, logs, or user profiles. Standard storage is used because
temporary objects do not benefit from infrequent-access minimum durations.

### Queue

Queue messages contain:

- `jobId`;
- input and output object keys;
- tool and contract versions;
- normalized spec hash;
- input object version or ETag;
- resource class;
- attempt number;
- random queue epoch and generation.

Queue delivery is treated as at-least-once. Every processing operation is idempotent. A duplicate message
cannot run two chargeable executions, overwrite an unrelated result, or double-settle usage. Exhausted
retries go to a dead-letter queue for sampled investigation without exposing file data.

### D1

D1 stores:

- anonymous session hashes and future tenant IDs;
- job state and timestamps;
- tool and contract versions;
- object keys and expiry timestamps;
- reserved and actual weighted units;
- normalized warning and error codes;
- codec and engine build IDs.

D1 does not store file bytes, filenames, thumbnails, previews, or signed URLs.

### Containers

The first deployment has one `image-engine` OCI image and a small container pool. It is built as a
portable internal HTTP service so the same image can run on Cloudflare Containers or another standard
container platform.

The container runs as a non-root user with:

- a fresh job-specific temporary directory;
- no arbitrary outbound network access;
- fixed CPU, memory, output-size, process-count, and wall-time limits;
- argument-array process execution without a shell;
- deterministic locale and timezone;
- immediate cleanup after success, failure, timeout, or cancellation.

No codec-per-tool containers, Kubernetes cluster, global Durable Object, or Workflow is introduced.
Application-owned Durable Objects beyond the Container SDK's required instance coordinator are reserved
for future tenant-level credit and concurrency serialization. Workflows are reserved for genuine
multi-stage document jobs such as OCR followed by compression and signing.

## Contracts and component boundaries

### `tool-job@1`

`tool-job@1` defines transport and lifecycle independently of image semantics:

- creation request and resource estimate;
- upload descriptors;
- exact-length upload completion acknowledgement;
- status and ordered phase events;
- cancellation;
- result descriptor;
- deletion acknowledgement;
- normalized error and retryability;
- reserved and actual usage.

The public job state machine is:

~~~text
created → uploading → queued → running
                               ├─ succeeded
                               ├─ failed
                               ├─ cancelled
                               └─ expired
~~~

Terminal states cannot transition back to a running state. Retry attempts remain internal to the same
job and are visible as attempt metadata rather than new user jobs.

### `image.optimize@1`

`image.optimize@1` is separate from the existing generic `image.pipeline@1`. It defines:

- accepted source formats: JPEG, PNG, and WebP;
- same-format output;
- `lossless`, `smart`, and format-appropriate preset semantics;
- metadata removal or preservation;
- orientation and color policy;
- minimum savings behavior;
- maximum attempts and resource budgets;
- warnings for original-return, normalization, and unsupported source features;
- output dimensions, MIME, byte length, engine build, and timing.

Keeping optimization separate prevents compression-specific analysis, verification, and candidate search
from destabilizing working resize and conversion behavior.

### `ToolManifest`

The existing catalog and registry grow a processing manifest that declares:

- tool and contract IDs;
- accepted and emitted MIME types;
- byte, pixel, dimension, page, and file-count limits;
- eligible execution locations;
- resource class and cost coefficient;
- retention policy;
- verifier;
- safe local fallback;
- availability and rollout flag.

The manifest is declarative metadata. It cannot load arbitrary runtime code.

### Planner, executor, and verifier

- **Planner:** inspects normalized metadata and selects content class, transform path, codec, preset,
  candidate budget, memory estimate, and fallback.
- **Executor:** runs the plan through `browser` or `server-native`.
- **Verifier:** independently checks signature, MIME, dimensions, orientation, color and alpha policy,
  output size, decode success, warnings, and quality requirements.

The verifier does not trust the codec process exit code.

## Image processing pipeline

Every server image follows this pipeline:

1. sniff magic bytes and validate the container structure;
2. enforce encoded-size, dimensions, decoded-pixel, metadata-size, frame-count, and expansion-ratio
   limits;
3. read EXIF orientation, ICC or other color information, alpha, animation, and format features;
4. classify the image as photo, screenshot or text, flat graphic, transparent graphic, noisy image, or
   already optimized;
5. apply orientation exactly once and normalize the working color space;
6. decode once and reuse the normalized image representation;
7. apply requested transforms once;
8. generate a bounded set of codec candidates;
9. decode and verify candidates;
10. choose the smallest candidate that passes the preset's quality and structural gates;
11. apply the metadata policy and validate the final signature;
12. return the original if no candidate provides the required saving.

Processing uses pixel and memory budgets rather than file count alone. A batch streams each completed
file to the result surface as soon as it is ready instead of waiting for the slowest file. Full decoded
images and codec heaps are released immediately.

### Metadata, orientation, color, and alpha

The default compression policy:

- applies EXIF orientation once and resets emitted orientation;
- emits SDR images in sRGB unless a later contract explicitly requests another color space;
- strips EXIF, XMP, GPS, comments, and embedded thumbnails;
- preserves dimensions and alpha semantics;
- never copies stale orientation, size, profile, or thumbnail fields;
- validates transparent edges over black, white, and checkerboard backgrounds.

A later explicit "preserve metadata" option can be added without changing the default.

## Codec strategy

### JPEG

The reference encoder is selected by a browser-independent bakeoff:

1. jpegli pinned to an audited source commit and deterministic native build;
2. MozJPEG as the mature comparison and fallback;
3. libjpeg-turbo as a speed-oriented fallback;
4. browser Canvas only as emergency local fallback.

jpegli is the preferred candidate because it emits standard JPEG and is designed for improved
rate-distortion performance. It is not promoted until its repository patent notice is reviewed for the
commercial build, the browser-independent corpus passes, and operational memory and CPU are measured.
If any release gate fails, MozJPEG remains the production encoder.

JPEG planning uses:

- lossless structural optimization and metadata removal before lossy re-encoding where useful;
- progressive scan and entropy optimization;
- content-aware chroma subsampling, using 4:4:4 for small text and line art and 4:2:0 for suitable
  photographs;
- bounded candidate search around calibrated presets;
- original-return when output is larger or quality falls below the gate.

### PNG

PNG has two explicit modes:

- **Lossless:** OxiPNG structural optimization with pixel-exact verification.
- **Smart:** permissively licensed Quantizr palette reduction followed by indexed PNG encoding and
  OxiPNG optimization.

Smart mode preserves the `.png` extension but is visually lossy and must be labelled accordingly. It is
not enabled for high-bit-depth, animation, wide-gamut, or unsupported alpha cases until those cases have
their own validated path.

pngquant and libimagequant are excluded from the closed commercial client and core server bundle unless
HereIsIt later buys a commercial license or deliberately accepts their GPL obligations.

### WebP

libwebp is the production implementation. Strict lossless, near-lossless, and lossy policies are separate
planner choices. Transparent lossless output uses exact transparent-pixel handling where required.

### Transform layer

The first implementation may use Sharp and dynamically linked libvips for decoding, resize, color
conversion, and streaming transforms while dedicated codecs control final output. libvips is isolated as
a server dependency, remains unmodified where practical, and ships with its LGPL notices and required
source or relinking information. If the compliance review rejects this dependency shape, the container
retains the same internal API and replaces the transform adapter without changing the public contract.

### Deferred formats

- AVIF remains behind a legal-review and feature-flag gate due third-party AV1 patent-pool claims.
- JPEG XL remains an optional future conversion format because browser support is not universal.
- HEIC input may later use a capability-detected platform or separately reviewed decoder, but HereIsIt
  does not distribute an HEVC encoder in this project.
- animation requires a separately designed temporal pipeline.

## Candidate search and profitability

The server does not run expensive perceptual optimization blindly on every request.

- Release and nightly labs perform deeper rate-distortion sweeps.
- Production presets are calibrated from those sweeps.
- A normal live request generates one fast candidate and at most two bounded refinements.
- A candidate that is already below the target and comfortably above the quality floor ends the search.
- A hard codec-specific CPU deadline returns the best verified intermediate candidate.
- Expensive "smallest acceptable file" searches are reserved for a future premium or background mode.

This preserves high free-tier quality without making every anonymous request a worst-case CPU job.

## Data flow

1. The file picker displays the server-transfer and automatic-deletion disclosure.
2. The client creates a job with normalized options and client-known file metadata.
3. The Worker validates the request, resource estimate, session quota, and account cost ceiling.
4. The Worker reserves weighted units and returns one authenticated upload route for that job.
5. The browser uploads the `File` to the Worker and reports real byte progress.
6. The Worker verifies `Content-Length`, counts the streamed bytes, performs a fixed-length create-only
   R2 write, verifies the object, and atomically enqueues the job.
7. The container claims the job idempotently, processes it, verifies the result, and records actual
   resource use.
8. The input object is deleted after successful processing or terminal failure.
9. The result becomes available through an authenticated attachment stream.
10. Only where the real-device matrix proves a browser-specific download handoff signal does the browser
    acknowledge the download and trigger deletion; fetching bytes or calling `anchor.click()` alone is
    insufficient.
11. Otherwise deletion becomes due at 30 minutes and the five-minute application sweeper targets removal
    within 35 minutes under healthy operation. This is an application SLO, not a hard maximum: an outage
    can delay deletion, and the one-day R2 expiration lifecycle is only a last-resort safety net.

The browser may use streaming-to-disk where supported. A compatibility path may hold a result Blob for a
direct download, but it must not add a share sheet or preview-first download flow.

## Progress and user experience

The UI reports real phases:

- uploading with byte progress;
- queued;
- validating;
- inspecting and classifying;
- decoding and normalizing;
- optimizing;
- verifying;
- preparing download;
- completed or original retained.

The UI does not fabricate a smooth percentage for an opaque native step. It may show determinate
progress where bytes or pages are measurable and phase-level progress elsewhere. Completed batch items
become downloadable immediately.

## Error handling and retries

Errors are stable product codes rather than raw codec messages.

- Invalid structure, unsupported features, policy violations, and exceeded hard input limits are
  non-retryable.
- A transient container or storage error retries the same idempotent job at most twice.
- A native out-of-memory result may retry once in the next resource class when the estimate permits.
- A codec timeout returns the best verified intermediate result when one exists; otherwise it offers a
  faster preset.
- Queue congestion applies backpressure before upload where possible and shows an honest queued state.
- Cancellation stops queued work or signals the active process, releases reservations, and deletes
  temporary objects.
- `NO_SIZE_REDUCTION` becomes a successful original-return outcome, not a failed job.
- An engine crash never exposes stderr, paths, command lines, or file metadata to the user.

Usage is settled exactly once. Failed infrastructure work refunds the reservation. Valid work that
returns the original records its real cost for unit-economics analysis.

## Deletion and privacy

Deletion has three layers:

1. explicit deletion in every success, failure, cancellation, and acknowledged-download path;
2. a five-minute sweeper for expired or orphaned objects;
3. an R2 lifecycle rule as a last-resort safety net.

The UI says acknowledged downloads trigger an immediate deletion attempt and unacknowledged results have
a healthy-operation 35-minute deletion SLO. It explicitly allows exceptional delay instead of promising
a hard maximum. R2 lifecycle timing is not used for a stronger promise because lifecycle execution is
not exact: a one-day expiration rule typically removes objects later and can itself be delayed.
Monitoring alerts and opens the server-processing circuit on old input objects, old result objects,
deletion failures, or a non-zero orphan count.

An object-deletion outage must not extend the lifetime of the full job record. At the 24-hour terminal
record boundary, the application erases the job, token/session/network hashes, request/spec, ledger,
quarantine, and content-derived operational fields. If an R2 object still exists, deletion continues
from a minimal tombstone containing only independently random object keys, existence booleans, retry
timing/count, and a normalized error code. Object keys and R2 custom metadata contain no job ID,
filename, session/network identifier, or caller-supplied value. Rotating abuse hashes are independently
scrubbed from job/ledger state and aggregate rows on their short retention schedule.

Application logs and analytics may contain:

- a fixed 12-hex prefix of the anonymous session hash;
- job ID;
- tool, contract, engine, and codec build IDs;
- input and output byte counts;
- pixel count;
- phase, queue, CPU, and total timings;
- peak memory or resource class;
- normalized warnings and errors;
- reserved and actual weighted units.

They must never contain filenames, file contents, thumbnails, extracted text, metadata values, signed
URLs, object credentials, or user-provided watermark text.

Production and staging disable automatic Worker invocation logs and traces because URL and binding
attributes can expose job paths or object keys outside the allowlisted schema. Only sampled custom
content-free events are persisted, with the reviewed seven-day Worker/Container log retention disclosed
in the privacy inventory.

Cost accounting uses a separate private telemetry path rather than broad invocation logging. An
unsampled Workers Trace Events Logpush job exports only `CPUTimeMs`, entrypoint, timestamp, event type,
outcome, script name, and script version to a dedicated R2 bucket; sealed objects are explicitly deleted and a
three-day lifecycle is only a delayed-cleanup backstop, not a hard retention maximum. Request events,
URLs, headers, console logs, and exceptions are excluded at the source. Identifier-free Analytics
Engine route points cross-check invocation coverage, and provider Container usage is imported only as
hourly resource aggregates. A seven-day content-free object/ETag ledger makes the import exactly once
without linking it to jobs, sessions, networks, or files. The privacy inventory discloses each field
set, deletion behavior, and provider/application retention.

Worker Version Metadata ties every imported Trace `ScriptVersion` to the exact module, generated config,
release report, and admission state. Bootstrap and secret-created intermediate versions remain
rollout-zero and are priced, but only an attested active version may admit a job.

Before any public server rollout, HereIsIt publishes reviewed Korean privacy and terms pages linked from
the upload disclosure and global footer. The privacy inventory names uploaded file contents, job/session
metadata, short-lived pseudonymous abuse buckets, exact application/record retention, Cloudflare
processing and any overseas processing/transfer details, user rights, and the real operator contact. A
generic consent checkbox is not assumed to be the legal basis: Korean counsel must approve the actual
basis and bind an immutable review artifact to the exact policy hashes. If separate consent is required,
server rollout remains disabled until the product supplies it.

The policy distinguishes active-table deletion from Cloudflare D1 paid-plan Time Travel history, which
is always enabled and may remain restorable for up to 30 days. A restore is an incident operation:
admission is first forced to zero, restored rows and R2 objects are reconciled, stale Queue messages are
fenced by a newly random epoch plus generation, and only a fresh maintainer canary may resume processing.

## Security model

- Never trust extensions or `Content-Type`; inspect magic bytes and format structure.
- Reject decompression bombs, excessive dimensions, excessive metadata, unsupported frame counts, and
  pathological expansion before full decode where possible.
- Run native tools as non-root with job-specific directories and no shell interpolation.
- Disable external resource fetching in image, future HTML, Office, and PDF processors unless a
  separately reviewed contract requires it.
- Prevent cross-job temporary-file access.
- Bound CPU, memory, disk, output bytes, file descriptors, subprocess count, and wall time.
- Apply rate limiting for abuse mitigation and D1-backed accounting for exact quotas.
- Use random opaque object keys and short-lived bearer capabilities.
- Fuzz parsers and retain malformed regression samples without user data.
- Keep codec and parser CVE monitoring separate from application dependency monitoring.

## Quality lab

The repository gains a provenance-controlled corpus containing:

- ordinary, portrait, night, and noisy photographs;
- Korean text, UI, and code screenshots;
- logos, illustrations, gradients, and flat graphics;
- transparent and semi-transparent PNGs;
- already optimized JPEG, PNG, and WebP;
- EXIF orientation and ICC profile fixtures;
- large dimensions, odd dimensions, and edge cases;
- malformed and truncated inputs;
- decompression-bomb fixtures;
- user-reported failure patterns recreated or included only with permission.

Each fixture records a SHA-256, provenance, fixture license, dimensions, bit depth, alpha, orientation,
profile, animation state, and intended assertions.

### Metrics

- Lossless paths compare normalized decoded pixel hashes.
- SSIMULACRA2 is the primary offline lossy metric.
- libjxl Butteraugli is the secondary perceptual and artifact-localization metric.
- SSIM and PSNR are diagnostic only.
- Text, thin lines, alpha fringes, and color have separate local checks.
- Human A/B review covers representative release candidates.

Metrics are versioned with colorspace, alpha, scaling, and invocation settings. Scores from different
Butteraugli implementations are never mixed.

### Release gates

The first production rollout requires:

- source format, dimensions, orientation, color policy, and alpha policy are correct;
- valid supported-file success rate is at least 99%;
- severe color, orientation, or alpha regressions are zero in the release corpus;
- lossless outputs have identical normalized pixels;
- a lossy candidate is no more than 1.0 SSIMULACRA2 point below the pinned reference at the compared
  size tier and no more than 0.1 worse in the pinned Butteraugli scale;
- at least 90% of the reproduced false `NO_SIZE_REDUCTION` corpus either produces at least 5% savings
  or proves that no tested production candidate can provide 5% savings at the pinned quality floor;
- representative median output size is no more than 5% larger than iLoveIMG at comparable visual
  quality;
- at least one strategic class—Korean screenshots, transparent PNG, or photographic JPEG—has a
  documented quality-size advantage;
- a larger output is never returned as the compressed result;
- a 12 MP warm JPEG or WebP job has p95 server processing time at or below three seconds;
- a 12 MP standard PNG job has p95 server processing time at or below eight seconds;
- ordinary image jobs remain at or below 512 MB peak native memory;
- cancellation reaches the active process within one second;
- every terminal and download path passes deletion tests;
- cost per 1,000 jobs and its p95 distribution are measured before rollout, and the p95 valid free job
  remains within the configured per-job weighted-unit admission budget.

The competitor comparison is a product benchmark, not a permanent contractual SLA. It uses only files
HereIsIt is authorized to upload.

## Test strategy

- **Pure unit tests:** manifests, contract validation, state transitions, content classification, planner
  decisions, cost estimation, naming, and deletion decisions.
- **Codec integration tests:** real pinned binaries, signatures, decode validation, dimensions, metadata,
  alpha, and candidate selection.
- **Control-plane integration tests:** authenticated exact-length streaming upload, oversized/truncated
  rejection, queue delivery, idempotency, usage settlement, cancellation, download, and deletion.
- **Browser end-to-end tests:** mobile and desktop upload, real progress, completed-item download, retry,
  original-return, and local fallback.
- **Chaos tests:** duplicate queue delivery, container crash, timeout, OOM, storage failure, download
  interruption, cancellation races, and sweeper recovery.
- **Security tests:** malformed files, decompression bombs, command injection, object-key confusion,
  cross-job access, upload-length abuse, and credential or bearer-token log leakage.
- **Performance tests:** cold start, warm time, first feedback, p50 and p95 processing, peak memory,
  bytes, quality metrics, and weighted cost.
- **Supply-chain tests:** SBOM generation, allowlist enforcement, bundled `LICENSE` and `PATENTS` files,
  artifact hashes, and prohibited-license detection.

Pull requests use a small corpus. Nightly jobs run the full rate-distortion suite. Releases run the
browser/device matrix and native container suite.

## Cost and monetization controls

Admission and accounting use weighted processing units rather than request count:

~~~text
weighted units =
  encoded bytes
  + decoded pixels × content coefficient
  + expected CPU seconds × codec coefficient
  + memory GiB-seconds
  + output bytes
~~~

The exact coefficients are versioned operational configuration derived from measurements. The system
reserves estimated units before upload and settles actual units exactly once.

Initial anonymous limits:

- at most 20 files per task;
- at most 30 MB and 40 megapixels per file;
- one active native job per anonymous session;
- a configurable daily weighted-unit allowance;
- account-wide admission stops for new free jobs when the configured daily cost ceiling is reached.

The daily free-compute ceiling is a required production deployment setting and has no implicit non-zero
default. Production server jobs remain disabled until the operator sets a value within an explicitly
approved monthly infrastructure budget. Increasing it requires a reviewed configuration change based on
measured revenue and workload data; it is not a user-facing product promise.

Free and paid tiers use the same core quality. Future paid value comes from larger batches and files,
priority, saved presets, automation, API access, ad removal, team controls, and regional processing.
Low-cost local transforms preserve free usefulness without consuming native compute.

The primary business dashboard reports:

- cost per 1,000 jobs;
- projected monthly cost under steady, bursty, and sparse traffic, including the container and 128 MiB
  Durable Object active tail, requests/duration/storage, and Worker/Queue/D1/R2/log costs;
- revenue per 1,000 tool sessions;
- jobs and weighted units per session;
- success and original-return rate;
- repeat usage;
- queue and processing percentiles;
- free-to-paid conversion after payments exist.

The application circuit uses the same signed price model and content-free hourly counters. Worker CPU
comes from the per-invocation Trace Events `CPUTimeMs` field; Container CPU, allocated memory/disk, and
transmitted bytes come from `containersUsageAdaptiveGroups`, while application activity segments provide
an independent upper-bound and sparse/bursty projection model. Workers Logpush, its R2 operations and
storage, Analytics Engine, Queue, D1, R2, Durable Object, and fixed-plan costs are all priced. Missing,
sampled, late, or schema-drifted provider data fails server admission closed, and consecutive
over-budget evaluations open the circuit; weighted compute units alone are not treated as a substitute
for actual operating cost. Each sealed hour binds its accounting epoch, model/schema/release hashes, and
per-service monetary breakdown; a model change or D1 restore starts a fresh maintainer-only epoch rather
than repricing history.

## Licensing, patents, and supply chain

This design is an engineering risk assessment, not legal advice. Open-source copyright obligations and
codec patent clearance are independent release gates.

The default allowlist is MIT, BSD, Apache-2.0, zlib, IJG-style, and similarly permissive licenses.
LGPL dependencies require an explicit distribution and relinking review. GPL and AGPL components are
blocked from the client and core production images unless a separately approved commercial license or
deliberate open-source compliance decision exists.

Each native image records:

- exact upstream repository and commit or release;
- compiler and linker versions;
- build flags and enabled codec features;
- transitive native dependency inventory;
- artifact hashes;
- SBOM;
- `LICENSE`, `NOTICE`, and `PATENTS` texts;
- source or relinking materials required by applicable licenses;
- known-vulnerability scan result.

The Pages artifact, no-bundle Worker module, and production JavaScript lockfile graph receive the same
release treatment: exact hashes, SBOMs, reviewed license policy/notices, and high/critical vulnerability
gates. Action commits alone are insufficient; Syft, Trivy, Buildx, BuildKit, the selected linux/amd64
BuildKit manifest, and the Trivy vulnerability database are version/digest pinned and recorded in the
release report.

The staging and production Pages trees are built separately from strictly validated immutable Worker API
origins. The built candidate records those origins before local review; the offline evidence then signs
the origins and both tree hashes, and each deployment must prove its actual Worker target matches. For
long-term GitHub Release rollback, each Pages tree also has a dependency-free deterministic USTAR asset
with fixed metadata. Both archive SHA-256 and safely extracted tree SHA-256 are bound into the candidate
and deployment records, so a directory is never rebuilt or uploaded ambiguously during rollback.

Authorized corpus and competitor binaries never enter CI. A trusted maintainer workstation runs the
pinned candidate locally and emits only bounded content-free JSON metrics/reviews and input/output
hashes. That canonical evidence is signed with an offline Ed25519 key and uploaded with a detached
signature to a unique asset in the private repository; CI verifies the committed public key before using
it. Raw corpus, competitor outputs, filenames, paths, thumbnails, and fuzz reproducers remain local.

Runtime codec downloads from a CDN are prohibited. Production artifacts are built and promoted through
the controlled supply chain.

Initial legal posture:

- JPEG, PNG, and WebP are the production-default formats.
- jpegli is counsel-reviewed before promotion; MozJPEG remains the fallback.
- OxiPNG, Quantizr, and libwebp remain pinned and attributed.
- AVIF is feature-flagged off pending a written patent position.
- JPEG XL is deferred as an optional conversion format.
- no HEVC/HEIC encoder is distributed.

## First delivery

### Included

- `tool-job@1`;
- `image.optimize@1`;
- API Worker;
- R2 upload, result, deletion, and sweeper paths;
- Queue delivery, retries, dead-letter handling, and idempotency;
- D1 job and usage state;
- one portable `image-engine` OCI image;
- JPEG bakeoff and one promoted production encoder;
- OxiPNG lossless PNG;
- validated Quantizr smart PNG;
- libwebp lossless, near-lossless, and lossy policies;
- planner, executor, and verifier boundaries;
- `/image/compress` server-default integration;
- local feature-flag fallback;
- direct download-only result flow;
- structured privacy-safe telemetry;
- corpus, benchmark, chaos, deletion, security, and license checks;
- updated server-processing and deletion disclosures.

### Excluded

- PDF server migration;
- authentication and payments;
- public API and webhooks;
- advanced or animated formats;
- AI features;
- multi-region processing;
- Server migration of resize, convert, crop, rotate, or watermark;
- premium deep-search mode.

## Rollout and rollback

Rollout phases:

1. local container and control-plane integration;
2. pinned corpus benchmark;
3. maintainer-only production jobs;
4. five-percent canary;
5. twenty-five-percent canary;
6. full server-default rollout.

Production deploy, promotion, rollback, restore, and production secret rotation are serialized under one
release-tag-independent operational lock held through immutable control-record publication. A queued
operation must re-resolve the latest control-chain tip and live Cloudflare deployment after acquiring the
lock; stale predecessor input fails before credentials or mutation rather than forking operational state.

Automatic circuit failover to the safe local executor occurs when a reviewed threshold is breached for:

- supported-input failure rate;
- severe verifier failures;
- p95 processing time;
- OOM or timeout rate;
- output-size regression;
- cost per 1,000 jobs;
- deletion failures.

Engine and codec build IDs are immutable. A guarded operator workflow may then roll routing back to a
previous proven server engine; it never rebuilds an old binary or mutates production outside the
serialized control-record chain.

## Long-term PDF direction

Later PDF specifications use separate containers and the same job platform:

- QPDF for structural operations and validation;
- Apache PDFBox for detailed manipulation, forms, and fonts;
- PDFium for rendering, previews, conversion, and visual verification;
- the HereIsIt image engine for embedded-image analysis and recompression;
- isolated LibreOffice and Chromium workers for Office and HTML conversion;
- Tesseract and separately licensed document models for OCR and layout analysis;
- a separate signing service for private keys, PAdES, identity, and audit trails.

Ghostscript, MuPDF, Poppler, iText, and other GPL, AGPL, or dual-commercial components are not introduced
into the core without an explicit licensing decision. PDF-to-Office reconstruction and full electronic
signature workflows are treated as separate product programs rather than small utility features.

## Primary references

- Cloudflare Workers limits: <https://developers.cloudflare.com/workers/platform/limits/>
- Cloudflare Containers overview: <https://developers.cloudflare.com/containers/>
- Cloudflare Containers pricing: <https://developers.cloudflare.com/containers/pricing/>
- Cloudflare Workers Streams: <https://developers.cloudflare.com/workers/runtime-apis/streams/>
- Cloudflare R2 Workers API: <https://developers.cloudflare.com/r2/api/workers/workers-api-reference/>
- Cloudflare R2 pricing: <https://developers.cloudflare.com/r2/pricing/>
- Cloudflare R2 lifecycle behavior:
  <https://developers.cloudflare.com/r2/buckets/object-lifecycles/>
- Cloudflare D1 Time Travel:
  <https://developers.cloudflare.com/d1/reference/time-travel/>
- Cloudflare Workers Logs:
  <https://developers.cloudflare.com/workers/observability/logs/workers-logs/>
- Cloudflare Workers Trace Events fields:
  <https://developers.cloudflare.com/logs/logpush/logpush-job/datasets/account/workers_trace_events/>
- Cloudflare Workers Logpush:
  <https://developers.cloudflare.com/workers/observability/logs/logpush/>
- Cloudflare Analytics Engine SQL API:
  <https://developers.cloudflare.com/analytics/analytics-engine/sql-api/>
- Cloudflare Container billing-usage metrics:
  <https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-container-metrics/>
- Cloudflare trace attributes:
  <https://developers.cloudflare.com/workers/observability/traces/spans-and-attributes/>
- Korean Personal Information Protection Act, Article 30 privacy policy and Article 28-8 overseas
  transfer: <https://www.law.go.kr/LSW/lsInfoP.do?ancYnChk=0&lsId=011357>
- Cloudflare Queues dead-letter queues:
  <https://developers.cloudflare.com/queues/configuration/dead-letter-queues/>
- jpegli: <https://github.com/google/jpegli>
- Google jpegli introduction:
  <https://opensource.googleblog.com/2024/04/introducing-jpegli-new-jpeg-coding-library.html>
- MozJPEG: <https://github.com/mozilla/mozjpeg>
- libjpeg-turbo: <https://github.com/libjpeg-turbo/libjpeg-turbo>
- OxiPNG: <https://github.com/oxipng/oxipng>
- Quantizr: <https://github.com/DarthSim/quantizr>
- libwebp: <https://github.com/webmproject/libwebp>
- libvips: <https://github.com/libvips/libvips>
- SSIMULACRA2: <https://github.com/cloudinary/ssimulacra2>
- Cloudinary Image Dataset 2022: <https://cloudinary.com/labs/cid22>
- libjxl Butteraugli discussion: <https://github.com/libjxl/libjxl/issues/2548>
- QPDF: <https://github.com/qpdf/qpdf>
- Apache PDFBox: <https://pdfbox.apache.org/>
- PDFium Python bindings and packaging notes:
  <https://github.com/pypdfium2-team/pypdfium2>
- Ghostscript licensing FAQ: <https://ghostscript.com/faq/index.html>
