CREATE TABLE canvases (
    id              TEXT    PRIMARY KEY NOT NULL,
    title           TEXT    NOT NULL CHECK (length(trim(title)) > 0 AND title = trim(title)),
    viewport_json   TEXT    NOT NULL CHECK (json_valid(viewport_json)),
    created_at_ms   INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms   INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
);

CREATE TABLE canvas_nodes (
    id              TEXT    PRIMARY KEY NOT NULL,
    canvas_id       TEXT    NOT NULL REFERENCES canvases(id),
    type            TEXT    NOT NULL CHECK (type = 'text'),
    content_json    TEXT    NOT NULL CHECK (json_valid(content_json)),
    x               REAL    NOT NULL,
    y               REAL    NOT NULL,
    created_at_ms   INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms   INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
);

CREATE INDEX idx_canvas_nodes_canvas_id ON canvas_nodes(canvas_id);
