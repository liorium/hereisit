-- NULL means legacy provenance has not yet been verified by replaying the immutable source object.
ALTER TABLE usage_log_object_hours ADD COLUMN handler_version_ids TEXT
  CHECK (handler_version_ids IS NULL OR (
    json_valid(handler_version_ids)
    AND json_type(handler_version_ids) = 'array'
    AND json_array_length(handler_version_ids) <= 128
  ));
