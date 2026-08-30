ALTER TABLE canvas_nodes
ADD COLUMN node_name TEXT NOT NULL DEFAULT ''
CHECK (length(node_name) <= 120 AND node_name = trim(node_name));
