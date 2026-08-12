ALTER TABLE container_activity_segments
ADD COLUMN engine_identity TEXT NOT NULL DEFAULT 'image:slot-0'
CHECK (engine_identity IN ('image:slot-0', 'pdf:slot-0'));

DROP INDEX container_activity_segments_time_idx;

CREATE INDEX container_activity_segments_identity_time_idx
ON container_activity_segments(engine_identity, started_at, billed_until_at);
