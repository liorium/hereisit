PRAGMA foreign_keys = OFF;

CREATE TABLE jobs_next (
  id TEXT PRIMARY KEY NOT NULL,
  client_request_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  session_hash TEXT NOT NULL,
  network_hash TEXT,
  network_hash_expires_at INTEGER,
  day_key TEXT NOT NULL,
  status TEXT NOT NULL,
  phase TEXT NOT NULL,
  phase_fraction REAL,
  phase_sequence INTEGER NOT NULL DEFAULT 0,
  contract_id TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  spec_hash TEXT NOT NULL,
  declared_bytes INTEGER NOT NULL,
  declared_mime TEXT NOT NULL,
  declared_width INTEGER,
  declared_height INTEGER,
  declared_page_count INTEGER,
  verified_input_mime TEXT,
  input_has_alpha INTEGER CHECK (input_has_alpha IN (0, 1)),
  content_class TEXT,
  input_key TEXT NOT NULL UNIQUE,
  input_etag TEXT,
  upload_version INTEGER NOT NULL DEFAULT 0,
  output_key TEXT UNIQUE,
  output_bytes INTEGER,
  output_mime TEXT,
  output_width INTEGER,
  output_height INTEGER,
  output_page_count INTEGER,
  pdf_profile TEXT,
  result_kind TEXT,
  reserved_units INTEGER NOT NULL,
  actual_units INTEGER,
  unit_coefficient_version INTEGER NOT NULL DEFAULT 1,
  cpu_ms INTEGER,
  memory_byte_milliseconds INTEGER,
  peak_memory_bytes INTEGER,
  processed_input_bytes INTEGER NOT NULL DEFAULT 0,
  processed_pixels INTEGER NOT NULL DEFAULT 0,
  resource_class TEXT NOT NULL,
  settlement_state TEXT NOT NULL DEFAULT 'reserved',
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt BETWEEN 1 AND 3),
  queue_epoch TEXT NOT NULL,
  queue_generation INTEGER NOT NULL DEFAULT 1,
  lease_token TEXT,
  lease_expires_at INTEGER,
  cancel_requested_at INTEGER,
  cold_start INTEGER CHECK (cold_start IN (0, 1)),
  container_ready_ms INTEGER,
  upload_expires_at INTEGER NOT NULL,
  processing_deadline_at INTEGER,
  result_expires_at INTEGER,
  terminal_record_expires_at INTEGER,
  download_acknowledged_at INTEGER,
  download_lease_hash TEXT,
  download_lease_expires_at INTEGER,
  engine_build_id TEXT,
  codec_build_id TEXT,
  warnings_json TEXT,
  tested_candidates INTEGER,
  error_code TEXT,
  error_guidance TEXT CHECK (
    error_guidance IS NULL OR error_guidance = 'TRY_BALANCED_PRESET'
  ),
  queued_at INTEGER,
  started_at INTEGER,
  engine_contact_started_at INTEGER,
  finished_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (session_hash, day_key)
    REFERENCES anonymous_usage(session_hash, day_key),
  CHECK (
    (
      contract_id = 'image.optimize@1'
      AND declared_mime IN ('image/jpeg', 'image/png', 'image/webp')
      AND declared_width BETWEEN 1 AND 32768
      AND declared_height BETWEEN 1 AND 32768
      AND declared_width * declared_height <= 40000000
      AND declared_page_count IS NULL
      AND output_page_count IS NULL
      AND pdf_profile IS NULL
    )
    OR
    (
      contract_id = 'pdf.optimize@1'
      AND declared_mime = 'application/pdf'
      AND declared_width IS NULL
      AND declared_height IS NULL
      AND declared_page_count BETWEEN 1 AND 100
      AND input_has_alpha IS NULL
      AND content_class IS NULL
      AND output_width IS NULL
      AND output_height IS NULL
      AND (output_page_count IS NULL OR output_page_count BETWEEN 1 AND 100)
      AND (pdf_profile IS NULL OR pdf_profile IN ('structural', 'image-optimized'))
    )
  ),
  CHECK (
    verified_input_mime IS NULL
    OR (contract_id = 'image.optimize@1' AND verified_input_mime IN ('image/jpeg', 'image/png', 'image/webp'))
    OR (contract_id = 'pdf.optimize@1' AND verified_input_mime = 'application/pdf')
  ),
  CHECK (
    output_mime IS NULL
    OR (contract_id = 'image.optimize@1' AND output_mime IN ('image/jpeg', 'image/png', 'image/webp'))
    OR (contract_id = 'pdf.optimize@1' AND output_mime = 'application/pdf')
  ),
  CHECK (
    (contract_id = 'image.optimize@1' AND resource_class IN ('image-standard-v1', 'image-large-v1'))
    OR (contract_id = 'pdf.optimize@1' AND resource_class = 'pdf-standard-v1')
  )
);

INSERT INTO jobs_next (
  id, client_request_id, token_hash, session_hash, network_hash,
  network_hash_expires_at, day_key, status, phase, phase_fraction,
  phase_sequence, contract_id, spec_json, spec_hash, declared_bytes,
  declared_mime, declared_width, declared_height, declared_page_count,
  verified_input_mime, input_has_alpha, content_class, input_key, input_etag,
  upload_version, output_key, output_bytes, output_mime, output_width,
  output_height, output_page_count, pdf_profile, result_kind, reserved_units,
  actual_units, unit_coefficient_version, cpu_ms, memory_byte_milliseconds,
  peak_memory_bytes, processed_input_bytes, processed_pixels, resource_class,
  settlement_state, attempt, queue_epoch, queue_generation, lease_token,
  lease_expires_at, cancel_requested_at, cold_start, container_ready_ms,
  upload_expires_at, processing_deadline_at, result_expires_at,
  terminal_record_expires_at, download_acknowledged_at, download_lease_hash,
  download_lease_expires_at, engine_build_id, codec_build_id, warnings_json,
  tested_candidates, error_code, error_guidance, queued_at, started_at,
  engine_contact_started_at, finished_at, created_at, updated_at
)
SELECT
  id, client_request_id, token_hash, session_hash, network_hash,
  network_hash_expires_at, day_key, status, phase, phase_fraction,
  phase_sequence, contract_id, spec_json, spec_hash, declared_bytes,
  declared_mime, declared_width, declared_height, NULL,
  verified_input_mime, input_has_alpha, content_class, input_key, input_etag,
  upload_version, output_key, output_bytes, output_mime, output_width,
  output_height, NULL, NULL, result_kind, reserved_units,
  actual_units, unit_coefficient_version, cpu_ms, memory_byte_milliseconds,
  peak_memory_bytes, processed_input_bytes, processed_pixels, resource_class,
  settlement_state, attempt, queue_epoch, queue_generation, lease_token,
  lease_expires_at, cancel_requested_at, cold_start, container_ready_ms,
  upload_expires_at, processing_deadline_at, result_expires_at,
  terminal_record_expires_at, download_acknowledged_at, download_lease_hash,
  download_lease_expires_at, engine_build_id, codec_build_id, warnings_json,
  tested_candidates, error_code, error_guidance, queued_at, started_at,
  engine_contact_started_at, finished_at, created_at, updated_at
FROM jobs;

DROP TABLE jobs;
ALTER TABLE jobs_next RENAME TO jobs;

CREATE INDEX jobs_expiry_idx
  ON jobs(status, upload_expires_at, result_expires_at);
CREATE INDEX jobs_terminal_record_idx
  ON jobs(terminal_record_expires_at);
CREATE INDEX jobs_lease_idx
  ON jobs(status, lease_expires_at);
CREATE INDEX jobs_network_status_idx
  ON jobs(network_hash, status);
CREATE INDEX jobs_network_hash_expiry_idx
  ON jobs(network_hash_expires_at);
CREATE UNIQUE INDEX jobs_client_request_idx
  ON jobs(session_hash, client_request_id);
CREATE INDEX jobs_health_window_idx
  ON jobs(finished_at, status, error_code, verified_input_mime, input_has_alpha, declared_bytes);

PRAGMA foreign_keys = ON;
