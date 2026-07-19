CREATE TABLE usage_log_objects (
  object_key TEXT PRIMARY KEY NOT NULL CHECK (
    length(CAST(object_key AS BLOB)) BETWEEN 1 AND 1024
    AND instr(CAST(object_key AS BLOB), x'00') = 0
  ),
  etag TEXT NOT NULL CHECK (
    length(CAST(etag AS BLOB)) BETWEEN 1 AND 256
    AND instr(CAST(etag AS BLOB), x'00') = 0
  ),
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  first_seen_at INTEGER NOT NULL CHECK (first_seen_at >= 0),
  last_seen_at INTEGER NOT NULL CHECK (last_seen_at >= first_seen_at),
  stable_observation_count INTEGER NOT NULL DEFAULT 1 CHECK (stable_observation_count >= 1),
  parsed_sha256 TEXT CHECK (
    parsed_sha256 IS NULL OR (
      length(parsed_sha256) = 64
      AND parsed_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  first_hour_key INTEGER CHECK (first_hour_key IS NULL OR first_hour_key >= 0),
  last_hour_key INTEGER CHECK (last_hour_key IS NULL OR last_hour_key >= 0),
  state TEXT NOT NULL DEFAULT 'observed'
    CHECK (state IN ('observed', 'parsed', 'sealed', 'delete-pending', 'deleted')),
  deleted_at INTEGER CHECK (deleted_at IS NULL OR deleted_at >= 0),
  CHECK (
    (first_hour_key IS NULL AND last_hour_key IS NULL)
    OR (
      first_hour_key IS NOT NULL
      AND last_hour_key IS NOT NULL
      AND last_hour_key >= first_hour_key
    )
  ),
  CHECK (
    (state = 'deleted' AND deleted_at IS NOT NULL)
    OR (state <> 'deleted' AND deleted_at IS NULL)
  )
) STRICT;

CREATE TABLE usage_log_object_hours (
  object_key TEXT NOT NULL REFERENCES usage_log_objects(object_key) ON DELETE CASCADE,
  hour_key INTEGER NOT NULL CHECK (hour_key >= 0),
  invocation_count INTEGER NOT NULL CHECK (invocation_count >= 0),
  worker_cpu_ms INTEGER NOT NULL CHECK (worker_cpu_ms >= 0),
  subset_invocation_count INTEGER NOT NULL CHECK (
    subset_invocation_count >= 0
    AND subset_invocation_count <= invocation_count
  ),
  payload_sha256 TEXT NOT NULL CHECK (
    length(payload_sha256) = 64
    AND payload_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY (object_key, hour_key)
) STRICT;

CREATE INDEX usage_log_object_hours_hour_idx
ON usage_log_object_hours(hour_key, object_key);

CREATE TABLE usage_log_hour_observations (
  accounting_epoch TEXT NOT NULL CHECK (
    length(accounting_epoch) = 32
    AND accounting_epoch NOT GLOB '*[^0-9a-f]*'
  ),
  hour_key INTEGER NOT NULL CHECK (hour_key >= 0),
  object_set_sha256 TEXT NOT NULL CHECK (
    length(object_set_sha256) = 64
    AND object_set_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  object_count INTEGER NOT NULL CHECK (object_count >= 0),
  object_bytes INTEGER NOT NULL CHECK (object_bytes >= 0),
  first_observed_at INTEGER NOT NULL CHECK (first_observed_at >= 0),
  last_observed_at INTEGER NOT NULL CHECK (last_observed_at >= first_observed_at),
  matching_observation_count INTEGER NOT NULL DEFAULT 1 CHECK (matching_observation_count >= 1),
  PRIMARY KEY (accounting_epoch, hour_key)
) STRICT;

CREATE INDEX usage_log_objects_state_seen_idx
ON usage_log_objects(state, last_seen_at);
