ALTER TABLE canvas_nodes
ADD COLUMN deleted_at_ms INTEGER
CHECK (deleted_at_ms IS NULL OR deleted_at_ms >= 0);
