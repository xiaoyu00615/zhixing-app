CREATE UNIQUE INDEX idx_canvas_nodes_canvas_id_id
ON canvas_nodes(canvas_id, id);

CREATE TABLE canvas_edges (
    id               TEXT    PRIMARY KEY NOT NULL,
    canvas_id        TEXT    NOT NULL REFERENCES canvases(id),
    source_node_id   TEXT    NOT NULL,
    target_node_id   TEXT    NOT NULL,
    relation_type    TEXT    NOT NULL DEFAULT 'default'
                             CHECK (length(trim(relation_type)) > 0
                                    AND relation_type = trim(relation_type)),
    direction        TEXT    NOT NULL DEFAULT 'forward'
                             CHECK (direction IN ('forward', 'bidirectional', 'none')),
    line_style       TEXT    NOT NULL DEFAULT 'solid'
                             CHECK (line_style IN ('solid', 'dashed', 'dotted')),
    created_at_ms    INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms    INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    deleted_at_ms    INTEGER CHECK (deleted_at_ms IS NULL OR deleted_at_ms >= 0),
    CHECK (source_node_id <> target_node_id),
    FOREIGN KEY (canvas_id, source_node_id)
        REFERENCES canvas_nodes(canvas_id, id),
    FOREIGN KEY (canvas_id, target_node_id)
        REFERENCES canvas_nodes(canvas_id, id)
);

CREATE INDEX idx_canvas_edges_canvas_id_active
ON canvas_edges(canvas_id, created_at_ms, id)
WHERE deleted_at_ms IS NULL;

CREATE UNIQUE INDEX idx_canvas_edges_forward_active_unique
ON canvas_edges(
    canvas_id,
    source_node_id,
    target_node_id,
    relation_type,
    direction
)
WHERE deleted_at_ms IS NULL AND direction = 'forward';

CREATE UNIQUE INDEX idx_canvas_edges_symmetric_active_unique
ON canvas_edges(
    canvas_id,
    CASE
        WHEN source_node_id < target_node_id THEN source_node_id
        ELSE target_node_id
    END,
    CASE
        WHEN source_node_id < target_node_id THEN target_node_id
        ELSE source_node_id
    END,
    relation_type,
    direction
)
WHERE deleted_at_ms IS NULL AND direction IN ('bidirectional', 'none');
