CREATE TABLE worker_version_attestations (
  version_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(version_id) = 36
    AND substr(version_id, 9, 1) = '-'
    AND substr(version_id, 14, 1) = '-'
    AND substr(version_id, 19, 1) = '-'
    AND substr(version_id, 24, 1) = '-'
    AND length(replace(version_id, '-', '')) = 32
    AND replace(version_id, '-', '') NOT GLOB '*[^0-9a-f]*'
  ),
  worker_module_sha256 TEXT NOT NULL CHECK (
    length(worker_module_sha256) = 64
    AND worker_module_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  generated_config_sha256 TEXT NOT NULL CHECK (
    length(generated_config_sha256) = 64
    AND generated_config_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  release_report_sha256 TEXT NOT NULL CHECK (
    length(release_report_sha256) = 64
    AND release_report_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  kind TEXT NOT NULL CHECK (
    kind IN ('bootstrap', 'secret-intermediate', 'active', 'retired')
  ),
  public_admission_allowed INTEGER NOT NULL DEFAULT 0 CHECK (
    public_admission_allowed IN (0, 1)
    AND (kind = 'active' OR public_admission_allowed = 0)
  ),
  observed_at INTEGER NOT NULL CHECK (
    typeof(observed_at) = 'integer'
    AND observed_at >= 0
  ),
  retired_at INTEGER CHECK (
    retired_at IS NULL OR (
      typeof(retired_at) = 'integer'
      AND retired_at >= observed_at
    )
  ),
  CHECK (
    (kind = 'retired' AND retired_at IS NOT NULL)
    OR (kind <> 'retired' AND retired_at IS NULL)
  )
);

CREATE UNIQUE INDEX worker_version_attestations_single_active_idx
  ON worker_version_attestations(kind)
  WHERE kind = 'active';

CREATE INDEX worker_version_attestations_retired_at_idx
  ON worker_version_attestations(retired_at)
  WHERE retired_at IS NOT NULL;
