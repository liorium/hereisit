PRAGMA foreign_keys = ON;

CREATE TABLE account_usage (
  day_key TEXT PRIMARY KEY NOT NULL,
  reserved_units INTEGER NOT NULL DEFAULT 0 CHECK (reserved_units >= 0),
  settled_units INTEGER NOT NULL DEFAULT 0 CHECK (settled_units >= 0),
  pending_jobs INTEGER NOT NULL DEFAULT 0 CHECK (pending_jobs >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE anonymous_usage (
  session_hash TEXT NOT NULL,
  day_key TEXT NOT NULL,
  reserved_units INTEGER NOT NULL DEFAULT 0 CHECK (reserved_units >= 0),
  settled_units INTEGER NOT NULL DEFAULT 0 CHECK (settled_units >= 0),
  active_jobs INTEGER NOT NULL DEFAULT 0 CHECK (active_jobs BETWEEN 0 AND 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_hash, day_key)
);

CREATE TABLE network_usage (
  network_hash TEXT NOT NULL,
  day_key TEXT NOT NULL,
  reserved_units INTEGER NOT NULL DEFAULT 0 CHECK (reserved_units >= 0),
  settled_units INTEGER NOT NULL DEFAULT 0 CHECK (settled_units >= 0),
  pending_jobs INTEGER NOT NULL DEFAULT 0 CHECK (pending_jobs >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (network_hash, day_key)
);

CREATE TABLE jobs (
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
  declared_width INTEGER NOT NULL,
  declared_height INTEGER NOT NULL,
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
    REFERENCES anonymous_usage(session_hash, day_key)
);

CREATE TABLE usage_ledger (
  job_id TEXT PRIMARY KEY NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  session_hash TEXT NOT NULL,
  network_hash TEXT,
  day_key TEXT NOT NULL,
  reserved_units INTEGER NOT NULL,
  actual_units INTEGER,
  outcome TEXT,
  settled_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE job_outbox (
  job_id TEXT PRIMARY KEY NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  sent_at INTEGER
);

CREATE TABLE maintenance_cursors (
  task TEXT PRIMARY KEY NOT NULL,
  cursor TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE rollout_control (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  circuit_open INTEGER NOT NULL DEFAULT 0 CHECK (circuit_open IN (0, 1)),
  reason TEXT,
  opened_at INTEGER,
  cost_accounting_epoch TEXT NOT NULL DEFAULT 'uninitialized'
);
INSERT INTO rollout_control (id) VALUES (1);

CREATE TABLE job_quarantine (
  job_id TEXT PRIMARY KEY NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  queue_name TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  error_code TEXT NOT NULL,
  quarantined_at INTEGER NOT NULL,
  inspected_at INTEGER
);

CREATE TABLE artifact_cleanup_tombstones (
  id TEXT PRIMARY KEY NOT NULL,
  input_key TEXT UNIQUE,
  output_key TEXT UNIQUE,
  input_exists INTEGER NOT NULL CHECK (input_exists IN (0, 1)),
  output_exists INTEGER NOT NULL CHECK (output_exists IN (0, 1)),
  first_failed_at INTEGER NOT NULL CHECK (first_failed_at >= 0),
  next_attempt_at INTEGER NOT NULL CHECK (next_attempt_at >= 0),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code TEXT,
  CHECK ((input_key IS NULL AND input_exists = 0) OR (input_key IS NOT NULL AND input_exists = 1)),
  CHECK ((output_key IS NULL AND output_exists = 0) OR (output_key IS NOT NULL AND output_exists = 1)),
  CHECK (input_exists = 1 OR output_exists = 1),
  CHECK (
    input_key IS NULL OR (
      substr(input_key, 1, 7) = 'inputs/'
      AND length(CAST(input_key AS BLOB)) = 43
      AND instr(CAST(input_key AS BLOB), x'00') = 0
      AND substr(input_key, 16, 1) = '-'
      AND substr(input_key, 21, 1) = '-'
      AND substr(input_key, 26, 1) = '-'
      AND substr(input_key, 31, 1) = '-'
      AND length(replace(substr(input_key, 8), '-', '')) = 32
      AND replace(substr(input_key, 8), '-', '') NOT GLOB '*[^0-9a-f]*'
    )
  ),
  CHECK (
    output_key IS NULL OR (
      substr(output_key, 1, 8) = 'outputs/'
      AND length(CAST(output_key AS BLOB)) = 44
      AND instr(CAST(output_key AS BLOB), x'00') = 0
      AND substr(output_key, 17, 1) = '-'
      AND substr(output_key, 22, 1) = '-'
      AND substr(output_key, 27, 1) = '-'
      AND substr(output_key, 32, 1) = '-'
      AND length(replace(substr(output_key, 9), '-', '')) = 32
      AND replace(substr(output_key, 9), '-', '') NOT GLOB '*[^0-9a-f]*'
    )
  ),
  CHECK (
    last_error_code IS NULL OR (
      length(CAST(last_error_code AS BLOB)) BETWEEN 1 AND 64
      AND instr(CAST(last_error_code AS BLOB), x'00') = 0
      AND last_error_code = upper(last_error_code)
      AND last_error_code NOT GLOB '*[^A-Z0-9_]*'
    )
  )
);

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
CREATE INDEX outbox_pending_idx
  ON job_outbox(sent_at, next_attempt_at);
CREATE INDEX cleanup_tombstones_retry_idx
  ON artifact_cleanup_tombstones(next_attempt_at);
