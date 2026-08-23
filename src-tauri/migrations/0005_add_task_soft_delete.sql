ALTER TABLE tasks
ADD COLUMN deleted_at_ms INTEGER NULL
CHECK (deleted_at_ms IS NULL OR deleted_at_ms >= 0);
