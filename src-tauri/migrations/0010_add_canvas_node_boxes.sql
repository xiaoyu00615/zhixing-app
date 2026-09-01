ALTER TABLE canvas_edges RENAME TO canvas_edges_v9;

DROP INDEX idx_canvas_edges_canvas_id_active;
DROP INDEX idx_canvas_edges_forward_active_unique;
DROP INDEX idx_canvas_edges_symmetric_active_unique;

ALTER TABLE canvas_nodes RENAME TO canvas_nodes_v9;

DROP INDEX idx_canvas_nodes_canvas_id;
DROP INDEX idx_canvas_nodes_canvas_id_id;

CREATE TABLE canvas_nodes (
    id              TEXT    PRIMARY KEY NOT NULL,
    canvas_id       TEXT    NOT NULL REFERENCES canvases(id),
    type            TEXT    NOT NULL CHECK (type IN ('text', 'sticky', 'node_box')),
    node_name       TEXT    NOT NULL DEFAULT ''
                             CHECK (node_name = trim(node_name)
                                    AND length(node_name) <= 120),
    content_json    TEXT    NOT NULL CHECK (json_valid(content_json)),
    x               REAL    NOT NULL,
    y               REAL    NOT NULL,
    created_at_ms   INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms   INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
);

INSERT INTO canvas_nodes
SELECT id, canvas_id, type, node_name, content_json, x, y,
       created_at_ms, updated_at_ms
FROM canvas_nodes_v9;

CREATE INDEX idx_canvas_nodes_canvas_id ON canvas_nodes(canvas_id);
CREATE UNIQUE INDEX idx_canvas_nodes_canvas_id_id
ON canvas_nodes(canvas_id, id);

CREATE TABLE canvas_edges (
    id                  TEXT    PRIMARY KEY NOT NULL,
    canvas_id           TEXT    NOT NULL REFERENCES canvases(id),
    source_node_id      TEXT    NOT NULL,
    target_node_id      TEXT    NOT NULL,
    relation_type       TEXT    NOT NULL DEFAULT 'default'
                                CHECK (length(trim(relation_type)) > 0
                                       AND relation_type = trim(relation_type)),
    direction           TEXT    NOT NULL DEFAULT 'forward'
                                CHECK (direction IN ('forward', 'bidirectional', 'none')),
    line_style          TEXT    NOT NULL DEFAULT 'solid'
                                CHECK (line_style IN ('solid', 'dashed', 'dotted')),
    membership_position INTEGER,
    created_at_ms       INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms       INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    deleted_at_ms       INTEGER CHECK (deleted_at_ms IS NULL OR deleted_at_ms >= 0),
    CHECK (source_node_id <> target_node_id),
    CHECK (
        (relation_type IN ('ordered_box_member', 'unordered_box_member')
         AND membership_position IS NOT NULL
         AND membership_position >= 0
         AND direction = 'forward'
         AND line_style = 'solid')
        OR
        (relation_type NOT IN ('ordered_box_member', 'unordered_box_member')
         AND membership_position IS NULL)
    ),
    FOREIGN KEY (canvas_id, source_node_id) REFERENCES canvas_nodes(canvas_id, id),
    FOREIGN KEY (canvas_id, target_node_id) REFERENCES canvas_nodes(canvas_id, id)
);

INSERT INTO canvas_edges
SELECT id, canvas_id, source_node_id, target_node_id, relation_type,
       direction, line_style, NULL, created_at_ms, updated_at_ms, deleted_at_ms
FROM canvas_edges_v9;

CREATE INDEX idx_canvas_edges_canvas_id_active
ON canvas_edges(canvas_id, created_at_ms, id)
WHERE deleted_at_ms IS NULL;

CREATE UNIQUE INDEX idx_canvas_edges_forward_active_unique
ON canvas_edges(canvas_id, source_node_id, target_node_id, relation_type, direction)
WHERE deleted_at_ms IS NULL AND direction = 'forward';

CREATE UNIQUE INDEX idx_canvas_edges_symmetric_active_unique
ON canvas_edges(
    canvas_id,
    CASE WHEN source_node_id < target_node_id THEN source_node_id ELSE target_node_id END,
    CASE WHEN source_node_id < target_node_id THEN target_node_id ELSE source_node_id END,
    relation_type,
    direction
)
WHERE deleted_at_ms IS NULL AND direction IN ('bidirectional', 'none');

CREATE INDEX idx_canvas_edges_box_members_active
ON canvas_edges(
    canvas_id,
    target_node_id,
    relation_type,
    membership_position,
    id
)
WHERE deleted_at_ms IS NULL
  AND relation_type IN ('ordered_box_member', 'unordered_box_member');

CREATE UNIQUE INDEX idx_canvas_edges_box_member_active_unique
ON canvas_edges(canvas_id, source_node_id, target_node_id)
WHERE deleted_at_ms IS NULL
  AND relation_type IN ('ordered_box_member', 'unordered_box_member');

CREATE UNIQUE INDEX idx_canvas_edges_box_position_active_unique
ON canvas_edges(canvas_id, target_node_id, relation_type, membership_position)
WHERE deleted_at_ms IS NULL
  AND relation_type IN ('ordered_box_member', 'unordered_box_member');

DROP TABLE canvas_edges_v9;
DROP TABLE canvas_nodes_v9;
